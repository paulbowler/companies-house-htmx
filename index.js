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
// No server-side PDF parsing; provide document URLs for AI to fetch and analyze

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
    // Collect up to 3 document URLs for AI to fetch and analyze
    const documents = [];
    filingHistory.slice(0, 3).forEach(item => {
      const metaLink = item.links && (item.links.document_metadata || item.links.documentMetadata);
      const metaUrl = metaLink && (metaLink.startsWith('http')
        ? metaLink
        : `https://api.company-information.service.gov.uk${metaLink}`);
      if (metaUrl) {
        // Derive document URL
        const docUrl = metaUrl.replace(/document_metadata$/i, 'document');
        documents.push({ description: item.description, date: item.date, url: docUrl });
      }
    });
    // Construct messages for OpenAI
    // Construct messages for AI: provide company data, document URLs, and user request
    const messages = [
      { role: 'system', content: 'You are an expert in UK Companies House data, accounting, and company law. Use the provided API document URLs to fetch and analyze balance sheets and other submitted forms as needed. Provide complete, self-contained answers in a single response—including any extracted financial figures—without pausing or asking the user to wait.' },
      { role: 'user', content: `Company data: ${JSON.stringify({ company, officers, shareholders, filingHistory })}` },
      { role: 'user', content: `Document URLs for context: ${JSON.stringify(documents)}` },
      { role: 'user', content: `User request: ${prompt}` }
    ];
    // Call OpenAI Chat API
    const aiRes = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      { model: 'gpt-4.1-mini', messages: messages, max_tokens: 800 },
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
