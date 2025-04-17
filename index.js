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
// In-memory session store for conversation contexts
const sessions = {};
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
    // Initialize assistant session for this company
    sessions[company.company_number] = {
      messages: [
        { role: 'system', content: 'You are an expert in UK Companies House data, accounting, and company law.' },
        { role: 'system', content: JSON.stringify({ company_number: company.company_number }) }
      ]
    };
    res.render('partials/company', { company, officers, shareholders, filingHistory });
  } catch (err) {
    console.error(err.message);
    res.send('<div>Error loading company info</div>');
  }
});

// Handle analysis requests via OpenAI function calling
app.post('/company/:number/analyze', async (req, res) => {
  const userPrompt = req.body.prompt;
  const companyNumber = req.params.number;
  try {
    // Set up OpenAI client and function definitions
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: openaiApiKey });
    const functions = [
      {
        name: 'search_companies',
        description: 'Search companies by query string',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Free-text search query' }
          },
          required: ['query']
        }
      },
      {
        name: 'get_company_details',
        description: 'Retrieve company details for a given company number',
        parameters: {
          type: 'object',
          properties: {
            company_number: { type: 'string', description: 'The Companies House number' }
          },
          required: ['company_number']
        }
      },
      {
        name: 'get_company_officers',
        description: 'Retrieve company officers list',
        parameters: { type: 'object', properties: { company_number: { type: 'string' } }, required: ['company_number'] }
      },
      {
        name: 'get_company_psc',
        description: 'Retrieve persons with significant control',
        parameters: { type: 'object', properties: { company_number: { type: 'string' } }, required: ['company_number'] }
      },
      {
        name: 'get_filing_history',
        description: 'Retrieve filing history items',
        parameters: { type: 'object', properties: { company_number: { type: 'string' } }, required: ['company_number'] }
      }
    ];
    // Retrieve or initialize session messages for this company
    const session = sessions[companyNumber] || { messages: [] };
    const messages = session.messages;
    // Append user prompt
    messages.push({ role: 'user', content: userPrompt });
    // First API call to potentially invoke functions
    // Initial call: allow assistant to call functions if needed
    // First pass: allow assistant to call functions
    let response = await openai.chat.completions.create({ model: 'gpt-4.1-mini', messages, functions, function_call: 'auto' });
    let message = response.choices[0].message;
    // If a function call is requested by the assistant
    // If assistant invoked a function, execute and continue
    if (message.function_call) {
      const fnName = message.function_call.name;
      const fnArgs = JSON.parse(message.function_call.arguments);
      // Map function name to actual call
      const fnMap = {
        search_companies: args => axios.get(
          `https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(args.query)}`, authHeader
        ).then(r => r.data),
        get_company_details: args => axios.get(
          `https://api.company-information.service.gov.uk/company/${args.company_number}`, authHeader
        ).then(r => r.data),
        get_company_officers: args => axios.get(
          `https://api.company-information.service.gov.uk/company/${args.company_number}/officers?items_per_page=100`, authHeader
        ).then(r => r.data),
        get_company_psc: args => axios.get(
          `https://api.company-information.service.gov.uk/company/${args.company_number}/persons-with-significant-control?items_per_page=100`, authHeader
        ).then(r => r.data),
        get_filing_history: args => axios.get(
          `https://api.company-information.service.gov.uk/company/${args.company_number}/filing-history?items_per_page=100`, authHeader
        ).then(r => r.data)
      };
      const fnResult = await fnMap[fnName](fnArgs);
      // Append assistant call and function response to messages
      // Record the function call message
      messages.push(message);
      // Record the function response
      messages.push({ role: 'function', name: fnName, content: JSON.stringify(fnResult) });
      // Final assistant call without functions
      // Final assistant response after function execution
      // Final assistant response without further function calls
      const finalRes = await openai.chat.completions.create({ model: 'gpt-4.1-mini', messages });
      message = finalRes.choices[0].message;
    }
    // Save assistant message to session
    messages.push(message);
    // Send back the assistant's content
    res.render('partials/analysis', { analysis: message.content, prompt: userPrompt });
  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).send('<div>Error performing analysis</div>');
  }
});
// Start server
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
