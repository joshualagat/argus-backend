/**
 * Deterministic CSV parser for TradingView paper trading balance history exports.
 * Runs entirely on local compute — no Gemini API calls needed.
 *
 * Expected CSV columns (by index):
 *   0: Time           (YYYY-MM-DD HH:MM:SS)
 *   1: Balance Before (number)
 *   2: Balance After  (number) <-- leaderboard score
 *   3: Realized P&L (value)   (number)
 *   4: Realized P&L (currency)(string)
 *   5: Action         (verbose description string)
 */

/**
 * Parses a single CSV line respecting quoted fields (which may contain commas).
 */
function parseCsvLine(line) {
    const fields = [];
    let current = '';
    let insideQuote = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            insideQuote = !insideQuote;
        } else if (char === ',' && !insideQuote) {
            fields.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    // Push the last field
    fields.push(current.trim());
    return fields;
}

/**
 * Parses the Action column string to extract symbol, side, qty, and avgFillPrice.
 * Example: "Close long position for symbol TVC:USOIL at price 113.02 for 8979 units."
 * Example: "Commission for: Enter position for symbol TVC:USOIL at price 113.42 for 8979 units"
 */
function parseAction(action) {
    const symbolMatch = action.match(/symbol\s+([\w:.!]+)/i);
    const priceMatch = action.match(/at price\s+([\d.]+)/i);
    const qtyMatch = action.match(/for\s+([\d.]+)\s+units/i);

    // Determine side
    let side = 'Unknown';
    const lowerAction = action.toLowerCase();
    if (lowerAction.includes('commission')) {
        side = 'Commission';
    } else if (lowerAction.includes('close long')) {
        side = 'Sell';
    } else if (lowerAction.includes('close short')) {
        side = 'Buy';
    } else if (lowerAction.includes('enter position')) {
        side = 'Buy';
    }

    return {
        symbol: symbolMatch ? symbolMatch[1] : 'Unknown',
        side,
        qty: qtyMatch ? parseFloat(qtyMatch[1]) : 0,
        avgFillPrice: priceMatch ? parseFloat(priceMatch[1]) : 0,
    };
}

/**
 * Main parser: converts raw CSV text into the same `orders` array format
 * that the rest of the pipeline (sheetsManager.appendOrders) expects.
 *
 * @param {string} csvText - Raw CSV file content as a string
 * @returns {{ orders: Array }} Parsed orders in the standard format
 */
export function parseTradingViewCsv(csvText) {
    const lines = csvText
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0);

    if (lines.length < 2) {
        return { orders: [] };
    }

    // Skip header row (index 0)
    const orders = [];
    for (let i = 1; i < lines.length; i++) {
        const fields = parseCsvLine(lines[i]);

        // Guard: need at least 6 columns
        if (fields.length < 6) continue;

        const [timeStr, balanceBefore, balanceAfter, pnlValue, , action] = fields;

        // Strip commas from number strings and parse
        const accountBalance = parseFloat(balanceAfter.replace(/,/g, ''));
        const totalPnL = parseFloat(pnlValue.replace(/,/g, ''));

        // Parse the verbose Action column
        const { symbol, side, qty, avgFillPrice } = parseAction(action);

        orders.push({
            timestamp: timeStr,
            symbol,
            side,
            qty,
            avgFillPrice,
            accountBalance: isNaN(accountBalance) ? 0 : accountBalance,
            totalPnL: isNaN(totalPnL) ? 0 : totalPnL,
        });
    }

    // The TradingView CSV exports newest rows FIRST (descending).
    // We reverse so rows are appended oldest→newest into Google Sheets,
    // ensuring the LAST row in Column F is always the most recent balance.
    orders.reverse();

    return { orders };
}
