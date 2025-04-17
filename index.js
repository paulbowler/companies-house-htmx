require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = 3000;

app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
// parse URL-encoded bodies (for form submissions)
app.use(express.urlencoded({ extended: true }));
// parse JSON bodies
app.use(express.json());

const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
const authHeader = {
  headers: {
    Authorization: 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64')
  }
};
// OpenAI API key for analysis
const openaiApiKey = process.env.OPENAI_API_KEY;
// PDF parsing
const pdfParse = require('pdf-parse');

app.get('/', (req, res) => {
  res.render('index');
});

app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.send('');
  try {
    const response = await axios.get(
      'https://api.company-information.service.gov.uk/search/companies?q=' + encodeURIComponent(query),
      authHeader
    );
    const results = response.data.items.slice(0, 5);
    console.log(results);
    res.render('partials/results', { results });
  } catch (err) {
    console.error(err.message);
    res.send('');
  }
});

app.get('/company/:number', async (req, res) => {
  try {
    // Fetch company details, officers, shareholders (PSC), and filing history concurrently
    const companyNumber = req.params.number;
    const [companyRes, officersRes, pscRes, filingHistoryRes] = await Promise.all([
      axios.get(
        `https://api.company-information.service.gov.uk/company/${companyNumber}`,
        authHeader
      ),
      axios.get(
        `https://api.company-information.service.gov.uk/company/${companyNumber}/officers?items_per_page=100`,
        authHeader
      ),
      axios.get(
        `https://api.company-information.service.gov.uk/company/${companyNumber}/persons-with-significant-control?items_per_page=100`,
        authHeader
      ),
      axios.get(
        `https://api.company-information.service.gov.uk/company/${companyNumber}/filing-history?items_per_page=100`,
        authHeader
      )
    ]);
    const company = companyRes.data;
    const officers = officersRes.data.items || [];
    const shareholders = pscRes.data.items || [];
    const filingHistory = filingHistoryRes.data.items || [];
    res.render('partials/company', { company, officers, shareholders, filingHistory });
  } catch (err) {
    console.error(err.message);
    res.send('<div>Error loading company info</div>');
  }
});

// Handle analysis requests
app.post('/company/:number/analyze', async (req, res) => {
  const prompt = req.body.prompt;
  const companyNumber = req.params.number;
  try {
    // Fetch company data for context
    const [companyRes, officersRes, pscRes, filingHistoryRes] = await Promise.all([
      axios.get(
        `https://api.company-information.service.gov.uk/company/${companyNumber}`,
        authHeader
      ),
      axios.get(
        `https://api.company-information.service.gov.uk/company/${companyNumber}/officers?items_per_page=100`,
        authHeader
      ),
      axios.get(
        `https://api.company-information.service.gov.uk/company/${companyNumber}/persons-with-significant-control?items_per_page=100`,
        authHeader
      ),
      axios.get(
        `https://api.company-information.service.gov.uk/company/${companyNumber}/filing-history?items_per_page=100`,
        authHeader
      )
    ]);
    const company = companyRes.data;
    const officers = officersRes.data.items || [];
    const shareholders = pscRes.data.items || [];
    const filingHistory = filingHistoryRes.data.items || [];
    // Fetch and parse filing documents (e.g., PDFs) for context (limit to first 3)
    const documents = [];
    for (let i = 0; i < Math.min(filingHistory.length, 3); i++) {
      const item = filingHistory[i];
      try {
        // Determine metadata URL (prefer link in item if present)
        const metadataPath = item.links && (item.links.document_metadata || item.links.documentMetadata);
        const metaUrl = metadataPath
          ? `https://api.company-information.service.gov.uk${metadataPath}`
          : `https://api.company-information.service.gov.uk/company/${companyNumber}/filing-history/${item.transaction_id}/document_metadata`;
        // Get document metadata
        const metaRes = await axios.get(metaUrl, authHeader);
        const docPath = metaRes.data.links && (metaRes.data.links.document || metaRes.data.links.document_path);
        if (docPath) {
          // Fetch PDF
          const pdfRes = await axios.get(
            `https://api.company-information.service.gov.uk${docPath}`,
            { ...authHeader, responseType: 'arraybuffer' }
          );
          // Parse PDF text
          const parsed = await pdfParse(pdfRes.data);
          documents.push({ description: item.description, date: item.date, text: parsed.text });
        }
      } catch (docErr) {
        // No document available or parse failed; skip gracefully
        console.info(`Skipping filing ${item.transaction_id}: ${docErr.message}`);
      }
    }
    // Construct messages for OpenAI
    // Construct messages with documents
    const messages = [
      { role: 'system', content: 'You are an expert in UK Companies House data, accounting, and company law. Provide analysis, warnings, and risk profiles for corporate entities. You may reference provided financial document texts.' },
      { role: 'user', content: `Company data: ${JSON.stringify({ company, officers, shareholders, filingHistory })}.` },
      { role: 'user', content: `Document contexts (parsed text) for analysis: ${JSON.stringify(documents)}` },
      { role: 'user', content: `User request: ${prompt}` }
    ];
    // Call OpenAI Chat API
    const aiRes = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      { model: 'gpt-3.5-turbo', messages: messages, max_tokens: 800 },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiApiKey}` } }
    );
    const analysis = aiRes.data.choices[0].message.content;
    // Render analysis result along with the original prompt
    res.render('partials/analysis', { analysis, prompt });
  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).send('<div>Error performing analysis</div>');
  }
});
// Start server
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
