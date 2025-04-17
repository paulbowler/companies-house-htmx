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
    // Initialize assistant session for this company, instructing use of functions
    sessions[company.company_number] = {
      messages: [
        {
          role: 'system',
          content: `You are an expert in UK Companies House data, accounting, and company law. The current company number is ${company.company_number}. You have access to the following functions: search_companies, get_company_details, get_company_officers, get_company_psc, get_filing_history, get_document_metadata, get_document_contents. When the user requests data or analysis, you must immediately use the appropriate function calls. You must not output any internal reasoning, planning, or descriptive text—only emit the function call JSON or, once you have all required data, return the final answer exactly.`
        }
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
      },
      {
        name: 'get_document_metadata',
        description: 'Retrieve metadata for a filing document, including the content link to the document API',
        parameters: {
          type: 'object',
          properties: {
            company_number: { type: 'string', description: 'The Companies House number' },
            transaction_id: { type: 'string', description: 'The filing history transaction ID' }
          },
          required: ['company_number', 'transaction_id']
        }
      },
      {
        name: 'get_document_contents',
        description: 'Retrieve the PDF content for a given document ID as a base64-encoded string',
        parameters: {
          type: 'object',
          properties: {
            document_id: { type: 'string', description: 'The document ID from metadata' }
          },
          required: ['document_id']
        }
      }
    ];
    // Retrieve or initialize session messages for this company
    const session = sessions[companyNumber] || { messages: [] };
    const messages = session.messages;
    // Append user prompt
    messages.push({ role: 'user', content: userPrompt });
    // Iteratively handle any function calls requested by the assistant
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
      ).then(r => r.data),
      get_document_metadata: args => axios.get(
        `https://api.company-information.service.gov.uk/company/${args.company_number}/filing-history/${args.transaction_id}`,
        authHeader
      ).then(res => res.data),
      get_document_contents: args => axios.get(
        `https://document-api.company-information.service.gov.uk/document/${args.document_id}/content`,
        Object.assign({}, authHeader, { responseType: 'arraybuffer' })
      ).then(res => {
        const document_base64 = Buffer.from(res.data, 'binary').toString('base64');
        return { document_id: args.document_id, document_base64 };
      })
    };
    let message, response;
    while (true) {
      response = await openai.chat.completions.create({ model: 'gpt-4.1-mini', messages, functions, function_call: 'auto' });
      message = response.choices[0].message;
      if (!message.function_call) break;
      const fnName = message.function_call.name;
      const fnArgs = JSON.parse(message.function_call.arguments);
      if (!fnMap[fnName]) throw new Error(`Unsupported function: ${fnName}`);
      const fnResult = await fnMap[fnName](fnArgs);
      messages.push(message);
      messages.push({ role: 'function', name: fnName, content: JSON.stringify(fnResult) });
    }
    // Save assistant's final response and render
    messages.push(message);
    res.render('partials/analysis', { analysis: message.content, prompt: userPrompt });
  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).send('<div>Error performing analysis</div>');
  }
});
// Start server
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
