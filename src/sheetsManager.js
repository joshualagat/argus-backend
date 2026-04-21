import { google } from 'googleapis';
import path from 'path';

function getSpreadsheetId() {
    let idOrUrl = process.env.SPREADSHEET_ID || '';
    if (idOrUrl.includes('/d/')) {
        return idOrUrl.split('/d/')[1].split('/')[0];
    }
    return idOrUrl;
}

const auth = new google.auth.GoogleAuth({
    // Vercel deployment support: Use stringified JSON env var first, otherwise fallback to local file
    ...(process.env.GOOGLE_CREDENTIALS
        ? { credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS) }
        : { keyFile: path.resolve(process.cwd(), 'GOOGLE_APPLICATION_CREDENTIALS.json') }),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });

/**
 * Ensures a tab matching the username exists. If not, it creates it with headers.
 */
export async function ensureUserTab(username) {
    const spreadsheetId = getSpreadsheetId();
    const res = await sheets.spreadsheets.get({ spreadsheetId });
    const existingSheets = res.data.sheets.map(s => s.properties.title);

    if (!existingSheets.includes(username)) {
        try {
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [{ addSheet: { properties: { title: username } } }]
                }
            });

            const headers = ["Timestamp", "Symbol", "Side", "Quantity", "Avg Fill Price", "Account Balance", "Total P&L"];
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `${username}!A1:G1`,
                valueInputOption: "USER_ENTERED",
                requestBody: { values: [headers] }
            });
            console.log(`Created new tab for user: ${username}`);
        } catch (e) {
            // If the tab already exists (race condition / duplicate request), that's fine — just continue
            if (e?.errors?.[0]?.reason === 'badRequest' && e?.errors?.[0]?.message?.includes('already exists')) {
                console.log(`Tab "${username}" already exists, skipping creation.`);
            } else {
                throw e; // Re-throw any other unexpected errors
            }
        }
    }
}

/**
 * Filters the array of exact duplicate orders and appends the non-duplicates.
 */
export async function appendOrders(username, orderArray, discordTimestamp) {
    if (!orderArray || orderArray.length === 0) {
        return { success: false, reason: "No positions were extracted from the image." };
    }

    const spreadsheetId = getSpreadsheetId();
    const range = `${username}!A:G`;

    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const rows = res.data.values || [];

    const newRows = [];

    for (const orderData of orderArray) {
        let isDuplicate = false;

        // 1. Check against Google Sheet legacy rows
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row) continue;
            // Destructure to include the Timestamp mapping (row[0] is Column A)
            const [rowTimestamp, rowSymbol, rowSide, rowQty, rowPrice] = row;

            if (
                String(rowTimestamp).trim() === String(orderData.timestamp || "").trim() &&
                String(rowSymbol).trim() === String(orderData.symbol || "").trim() &&
                parseFloat(rowQty) === parseFloat(orderData.qty) &&
                parseFloat(rowPrice) === parseFloat(orderData.avgFillPrice)
            ) {
                isDuplicate = true;
                break;
            }
        }

        // 2. Check against rows we are staging to insert to avoid identical rows in the same batch
        for (const staged of newRows) {
            const [rowTimestamp, rowSymbol, rowSide, rowQty, rowPrice] = staged;
            if (
                String(rowTimestamp).trim() === String(orderData.timestamp || "").trim() &&
                String(rowSymbol).trim() === String(orderData.symbol || "").trim() &&
                parseFloat(rowQty) === parseFloat(orderData.qty) &&
                parseFloat(rowPrice) === parseFloat(orderData.avgFillPrice)
            ) {
                isDuplicate = true;
                break;
            }
        }

        if (!isDuplicate) {
            newRows.push([
                orderData.timestamp || new Date(discordTimestamp).toISOString(),
                orderData.symbol || "Unknown",
                orderData.side || "-",
                orderData.qty || 0,
                orderData.avgFillPrice || 0,
                orderData.accountBalance || 0,
                orderData.totalPnL || 0
            ]);
        }
    }

    if (newRows.length > 0) {
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `${username}!A:G`,
            valueInputOption: "USER_ENTERED",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: newRows }
        });
        return { success: true, count: newRows.length, ignored: orderArray.length - newRows.length };
    }

    return { success: false, reason: `Ignored all ${orderArray.length} position(s) because they were already in the Google Sheet.` };
}

/**
 * Crawls every single user tab safely, locates their most recent Account Balance,
 * overwrites the Leaderboard_Data tab safely for Vercel, and syncs the visual Top 5 UI.
 */
export async function syncGlobalLeaderboard() {
    const spreadsheetId = getSpreadsheetId();
    
    // 1. Fetch all sheet names globally
    let allSheetNames = [];
    try {
        const res = await sheets.spreadsheets.get({ spreadsheetId });
        allSheetNames = res.data.sheets.map(s => s.properties.title);
    } catch (e) {
        console.error("Failed to read sheet names:", e.message);
        return;
    }
    
    // 2. Automatically ensure Leaderboard_Data exists behind the scenes
    if (!allSheetNames.includes("Leaderboard_Data")) {
        try {
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: { requests: [{ addSheet: { properties: { title: "Leaderboard_Data" } } }] }
            });
            allSheetNames.push("Leaderboard_Data");
            console.log(`Auto-created missing data tab: Leaderboard_Data`);
        } catch (e) {
            console.error("Failed to create Leaderboard_Data tab:", e.message);
        }
    }

    // 3. Filter out non-user config tabs
    const excludeTabs = ["leaderboard", "Leaderboard_Data", "Summary", "Notes"]; 
    const userTabs = allSheetNames.filter(name => !excludeTabs.includes(name));

    if (userTabs.length === 0) {
        console.log("No user tabs found to synchronize.");
        return;
    }

    // 4. BatchGet Column F (Account Balance) for ALL user tabs simultaneously (High Performance)
    const ranges = userTabs.map(tab => `'${tab}'!F:F`);
    
    let batchRes;
    try {
        batchRes = await sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges });
    } catch (e) {
        console.error("Global Leaderboard BatchGet error:", e.message);
        return;
    }

    const valueRanges = batchRes.data.valueRanges || [];
    const consolidatedData = [];

    // 5. Parse the absolute last recorded Account Balance value in Column F for every user
    valueRanges.forEach((rangeObj, index) => {
        const username = userTabs[index];
        const values = rangeObj.values;
        if (values && values.length > 0) {
            let latestEquity = null;
            // Iterate backwards up the column to find the first non-empty numeric value
            for (let i = values.length - 1; i >= 0; i--) {
                const cellVal = values[i][0];
                if (cellVal !== undefined && cellVal !== null && String(cellVal).trim() !== "") {
                    // Quick comma strip just in case
                    const parsed = parseFloat(String(cellVal).replace(/,/g, ''));
                    if (!isNaN(parsed)) {
                        latestEquity = parsed;
                        break;
                    }
                }
            }
            if (latestEquity !== null) {
                consolidatedData.push({ name: username, val: latestEquity });
            }
        }
    });

    // 6. Overwrite Leaderboard_Data!A:B safely and comprehensively
    try {
        await sheets.spreadsheets.values.clear({
            spreadsheetId,
            range: `Leaderboard_Data!A:B`
        });

        const exportRows = [["TradingView Username", "Latest Equity"]];
        consolidatedData.forEach(userObj => exportRows.push([userObj.name, userObj.val]));

        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `Leaderboard_Data!A:B`,
            valueInputOption: "USER_ENTERED",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: exportRows }
        });
    } catch (e) {
        console.error("Failed to write to Leaderboard_Data:", e.message);
    }

    // 7. Sort the Master List natively sorting highest equity to lowest
    consolidatedData.sort((a, b) => b.val - a.val);
    const top5 = consolidatedData.slice(0, 5);

    // 8. Bulk write directly to the visual top 5 UI mapping (leaderboard!B4:E8)
    const templateRows = [];
    for (let i = 0; i < 5; i++) {
        if (i < top5.length) {
            templateRows.push([top5[i].name, "", "", top5[i].val]);
        } else {
            templateRows.push(["", "", "", ""]); // Clear out empties physically mapping B, C, D, E columns
        }
    }

    try {
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `leaderboard!B4:E8`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: templateRows }
        });
        console.log(`Successfully synced Global Leaderboard for ${consolidatedData.length} total players!`);
    } catch (e) {
        console.error("Leaderboard UI Update failed. Did you name your frontend tab exactly 'leaderboard'?", e.message);
    }
}

/**
 * Utility function designed for your future Vercel frontend dashboard.
 * Connects to the Google Sheet and reads the visual 'leaderboard' tab (A4:E8).
 * Returns the exact JSON array structure requested.
 */
export async function getLeaderboardData() {
    const spreadsheetId = getSpreadsheetId();
    
    // Fetch specifically the visual leaderboard block (A4:E8)
    const range = `leaderboard!A4:E8`;

    try {
        const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
        const rows = res.data.values || [];

        const leaderboardArray = [];

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            
            // Based on the template:
            // A4 = Position (row[0])
            // B4:D4 = Username (row[1])
            // E4 = Equity (row[4] - but if C and D are empty strings, it might technically be row[2] or row[3] if the array suppresses trailing empties. Safely extracting the last element:
            
            const position = row[0] || `${i + 1}th`;
            const username = row[1] || "";
            
            // Equity should theoretically be in index 4, but if middle columns are empty, Sheets sometimes truncates the array length. We take the last available index if length < 5
            const accountBalance = row.length > 2 ? row[row.length - 1] : "";

            if (username) {
                leaderboardArray.push({
                    "POSITION": position,
                    "USERNAMES": username,
                    "ACCOUNT BALANACE": accountBalance
                });
            }
        }

        // Return the exact structure requested: Array of objects containing an array of objects under 'LEADERBOARD' header
        return [
            {
                "LEADERBOARD": leaderboardArray
            }
        ];

    } catch (e) {
        console.error("Failed to read Leaderboard Data for frontend:", e.message);
        return [{ "LEADERBOARD": [] }];
    }
}
