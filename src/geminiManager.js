import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export async function extractFinancialData(csvText) {
    const prompt = `
You are an expert financial data extraction assistant. The user has provided the raw text contents of a TradingView paper trading balance history export in CSV format.

The CSV columns are ALWAYS in this exact order:
  Column A: Time          (format: YYYY-MM-DD HH:MM:SS)
  Column B: Balance Before (number)
  Column C: Balance After  (number) — THIS is the running account balance after the transaction
  Column D: Realized P&L (value) (number, can be negative)
  Column E: Realized P&L (currency) (string, e.g. "USD")
  Column F: Action        (verbose description string, contains symbol, direction, price, quantity)

For EVERY data row in the CSV (skip the header row), extract:
- timestamp: the exact value from Column A (Time)
- symbol: parse the symbol from Column F (e.g. TVC:USOIL, BITSTAMP:BTCUSD). If not found, use "Unknown"
- side: parse the direction from Column F action text. It will say "Close long", "Close short", "Enter position", etc. Map to "Buy", "Sell", "Long", or "Short"
- qty: parse the number of units from Column F (look for "for X units")
- avgFillPrice: parse the execution price from Column F (look for "at price X")
- accountBalance: use exactly the value from Column C (Balance After), stripping commas
- totalPnL: use exactly the value from Column D (Realized P&L value), stripping commas

Output a strictly valid JSON object with this structure:
{
  "orders": [
    {
      "timestamp": "string",
      "symbol": "string",
      "side": "string",
      "qty": number,
      "avgFillPrice": number,
      "accountBalance": number,
      "totalPnL": number
    }
  ]
}

Here is the raw .csv text to analyze:
---------
${csvText}
---------

**Strict Output Constraint:** Do absolutely not include Markdown wrappers (e.g. \`\`\`json). Output raw parseable JSON only.
    `;

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const response = await model.generateContent({
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: prompt }
                    ]
                }
            ],
            generationConfig: {
                responseMimeType: 'application/json'
            }
        });

        let textOutput = response.response.text();
        // Fallback for json blocks if the model wrapped it
        textOutput = textOutput.replace(/```json/gi, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(textOutput);
        
        // Return the full JSON containing { tradingViewUsername, orders }
        return parsed;
    } catch (error) {
        console.error('Error extracting data using Gemini:', error);
        throw new Error('Failed to extract financial data from the image.');
    }
}
