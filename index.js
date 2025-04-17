require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = 3000;

app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));

const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
const authHeader = {
  headers: {
    Authorization: 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64')
  }
};

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

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
