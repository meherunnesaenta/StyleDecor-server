const express = require('express')
const cors = require('cors');
const app = express();
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.SRIPE_SECRET);


const port = process.env.PORT || 3000;
const admin = require('firebase-admin');


const decoded = Buffer.from(process.env.FB_Service_Key, 'base64').toString(
  'utf-8'
)
const serviceAccount = JSON.parse(decoded)
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})


// middleware
app.use(express.json());
app.use(cors());


const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(' ')[1]
  console.log(token)
  if (!token) return res.status(401).send({ message: 'Unauthorized Access!' })
  try {
    const decoded = await admin.auth().verifyIdToken(token)
    req.tokenEmail = decoded.email
    console.log(decoded)
    next()
  } catch (err) {
    console.log(err)
    return res.status(401).send({ message: 'Unauthorized Access!', err })
  }
}





const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});
async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();
    const serviceCollection = client.db('styleDecor').collection('services');
    const reviewCollection = client.db('styleDecor').collection('reviews');

    app.post('/service', verifyJWT, async (req, res) => {
      const service = req.body;
      const result = await serviceCollection.insertOne(service);
      res.send(result);
    })

    app.get('/service', verifyJWT, async (req, res) => {
      const result = await serviceCollection.find().toArray();
      res.send(result);
    })

    

app.get('/service/:id', async (req, res) => {
  try {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid ID format' });
    }

    const query = { _id: new ObjectId(id) };
    const result = await serviceCollection.findOne(query);

    if (!result) {
      return res.status(404).json({ message: 'Service not found' });
    }

    result._id = result._id.toString();

    res.json(result);
  } catch (error) {
    console.error('Error fetching single service:', error);
    res.status(500).json({ message: 'Server error', details: error.message });
  }
});





// payment 

app.post('/create-booking-session', verifyJWT, async (req, res) => {
  const bookingInfo = req.body;

  
  const baseUrl = process.env.CLIENT_URL || 'http://localhost:5173';

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: bookingInfo.serviceName,
            images: bookingInfo.serviceImage ? [bookingInfo.serviceImage] : [],
          },
          unit_amount: Math.round(bookingInfo.price * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${baseUrl}/booking-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/services`,
      metadata: {
        serviceId: bookingInfo.serviceId,
        customerEmail: bookingInfo.customer.email,
        customerName: bookingInfo.customer.name || '',
        bookingDate: bookingInfo.bookingDate,
        location: bookingInfo.location,
        originalPriceBDT: bookingInfo.price,
      },
    });

    res.send({ url: session.url });
  } catch (error) {
    console.error('Stripe error:', error);
    res.status(500).send({ message: error.message || 'Payment session failed' });
  }
});


// নতুন route: success page থেকে call হবে, data verify + store করবে
app.post('/payment-success', verifyJWT, async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ success: false, message: 'No session ID' });
  }

  try {
    // Stripe session retrieve করে verify করো
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status === 'paid') {
      // এখানে database-এ booking save করো (তোমার bookingCollection)
      const bookingData = {
        serviceId: session.metadata.serviceId,
        customerEmail: session.metadata.customerEmail,
        customerName: req.tokenEmail || 'Unknown', // verifyJWT থেকে
        amount: session.amount_total / 100,
        currency: session.currency,
        stripeSessionId: sessionId,
        paymentIntentId: session.payment_intent,
        status: 'confirmed',
        bookedAt: new Date(),
        // অন্যান্য fields যোগ করো (bookingDate, location ইত্যাদি)
      };

      // bookingCollection.insertOne(bookingData); // তোমার collection name দিয়ে
      // res.send({ success: true, message: 'Booking saved' });

      res.json({ success: true });
    } else {
      res.json({ success: false, message: 'Payment not completed' });
    }
  } catch (error) {
    console.error('Payment verification error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});






    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);





app.get('/', (req, res) => {
  res.send('StyleDecor server is running!')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})