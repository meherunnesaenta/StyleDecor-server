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
    const bookingCollection = client.db('styleDecor').collection('bookings');
    const usersCollection = client.db('styleDecor').collection('users');
    const decoratorRequestsCollection = client.db('styleDecor').collection('decoratorRequests');

    app.post('/service', async (req, res) => {
      const service = req.body;
      const result = await serviceCollection.insertOne(service);
      res.send(result);
    })

    app.get('/service', async (req, res) => {
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




    // User role fetch route
    app.get('/users/:email/role', verifyJWT, async (req, res) => {
      const email = req.params.email;

      if (req.tokenEmail !== email) {
        return res.status(403).send({ message: 'Forbidden' });
      }

      try {
        const user = await usersCollection.findOne({ email });
        res.send({ role: user?.role || 'user' });
      } catch (error) {
        res.status(500).send({ message: 'Server error' });
      }
    });


    app.post('/become-decorator', verifyJWT, async (req, res) => {
      const email = req.tokenEmail
      const alreadyExists = await decoratorRequestsCollection.findOne({ email })
      if (alreadyExists)
        return res
          .status(409)
          .send({ message: 'Already requested, wait koro.' })

      const result = await decoratorRequestsCollection.insertOne({ email })
      res.send(result)
    })

    app.get('/decorator-requests', verifyJWT, async (req, res) => {
      const requester = await userCollection.findOne({ email: req.tokenEmail });
      if (requester?.role !== 'admin') {
        return res.status(403).send({ message: 'Forbidden' });
      }

      const requests = await decoratorCollection.find({ status: 'pending' }).toArray();
      res.send(requests);
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
            unit: bookingInfo.unit,
            serviceMode: bookingInfo.serviceMode,
            originalPriceBDT: bookingInfo.originalPriceBDT || bookingInfo.price,
          },
        });

        res.send({ url: session.url });
      } catch (error) {
        console.error('Stripe error:', error);
        res.status(500).send({ message: error.message || 'Payment session failed' });
      }
    });


    // Public route for home page services
app.get('/services', async (req, res) => {
  try {
    const result = await serviceCollection.find({ isActive: true }).toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: 'Error fetching services' });
  }
});



// Public route for top decorators
app.get('/top-decorators', async (req, res) => {
  try {
    const decorators = await userCollection
      .find({ role: 'decorator' })
      .limit(8)
      .toArray();

    res.send(decorators);
  } catch (error) {
    res.status(500).send({ message: 'Error fetching decorators' });
  }
});



app.post('/payment-success', verifyJWT, async (req, res) => {
  const { sessionId } = req.body;

  const session = await stripe.checkout.sessions.retrieve(sessionId);

  if (session.payment_status !== 'paid') {
    return res.status(400).send({ message: 'Payment not completed' });
  }

  const booking = {
    stripeSessionId: session.id,
    serviceName: session.metadata.serviceName,
    serviceId: session.metadata.serviceId,
    serviceImage: session.metadata.serviceImage,
    customerEmail: session.metadata.customerEmail,
    customerName: session.metadata.customerName,
    bookingDate: session.metadata.bookingDate,
    location: session.metadata.location,
    serviceMode: session.metadata.serviceMode,
    originalPriceBDT: session.metadata.originalPriceBDT,
    paidAmountUSD: session.amount_total / 100,
    status: 'confirmed',
    createdAt: new Date(),
  };

  await bookingsCollection.insertOne(booking);

  res.send({ success: true });
});





app.get('/my-bookings', verifyJWT, async (req, res) => {
  const email = req.tokenEmail;

  const bookings = await bookingsCollection
    .find({ customerEmail: email })
    .sort({ createdAt: -1 })
    .toArray();

  res.send(bookings);
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