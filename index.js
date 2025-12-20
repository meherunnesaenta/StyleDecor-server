const express = require('express')
const cors = require('cors');
const app = express();
require('dotenv').config();
const { MongoClient, ServerApiVersion } = require('mongodb');

const port = process.env.PORT || 3000

// middleware
app.use(express.json());
app.use(cors());


app.get('/', (req, res) => {
    res.send('StyleDecor server is running!')
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})