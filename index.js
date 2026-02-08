const express = require('express')
const cors = require('cors');
const app = express();
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET);



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
const corsOptions = {
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));


const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(' ')[1];

  console.log('[verifyJWT] Token received:', token ? 'YES (length: ' + token.length + ')' : 'NO TOKEN');

  if (!token) {
    console.log('[verifyJWT] → 401 No token');
    return res.status(401).send({ message: 'Unauthorized Access!' });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;

    console.log('[verifyJWT] Token verified successfully → email:', decoded.email);
    console.log('[verifyJWT] Full decoded payload:', JSON.stringify(decoded, null, 2).slice(0, 300) + '...'); // optional, truncate if too long

    next();
  } catch (err) {
    console.error('[verifyJWT] FAILED for URL:', req.originalUrl);
    console.error('[verifyJWT] Token (first 20):', token?.substring(0, 20) || 'NO TOKEN');
    console.error('[verifyJWT] Error code:', err.code);
    console.error('[verifyJWT] Error message:', err.message);
    console.error('[verifyJWT] Full error:', JSON.stringify(err, null, 2));

    return res.status(401).send({
      message: 'Token verification failed',
      code: err.code || 'unknown',
      details: err.message
    });
  }
};





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
    const decoratorCollection = client.db('styleDecor').collection('decorator')
    const paymentCollection = client.db('styleDecor').collection('payments');

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

    // User-এর নিজের Payment History (শুধু paid bookings)
    app.get('/my-payments', verifyJWT, async (req, res) => {
  const email = req.tokenEmail;

  try {
    const payments = await paymentCollection
      .find({ customerEmail: email })
      .sort({ paidAt: -1 }) // newest first
      .toArray();

    console.log(`[GET /my-payments] Found ${payments.length} payments for ${email}`);
    res.send(payments);
  } catch (err) {
    console.error("My payments error:", err);
    res.status(500).send({ message: 'Failed to load your payment history' });
  }
});



    app.get('/manage-bookings', verifyJWT, async (req, res) => {
      const adminUser = await usersCollection.findOne({
        email: req.tokenEmail
      });

      if (adminUser?.role !== 'admin') {
        return res.status(403).send({ message: 'Forbidden' });
      }

      const bookings = await bookingCollection
        .find()
        .sort({ createdAt: -1 })
        .toArray();

      res.send(bookings);
    });

// Admin - All Payments from paymentCollection
app.get('/admin/payments', verifyJWT, async (req, res) => {
  const adminUser = await usersCollection.findOne({ email: req.tokenEmail });

  if (!adminUser || adminUser.role !== 'admin') {
    return res.status(403).send({ message: 'Admin access required' });
  }

  try {
    const payments = await paymentCollection
      .find({})
      .sort({ paidAt: -1 })
      .toArray();

    console.log(`[GET /admin/payments] Found ${payments.length} payments`);

    res.send(payments);
  } catch (err) {
    console.error('Error fetching payments:', err);
    res.status(500).send({ message: 'Failed to load payment history' });
  }
});


    // User role fetch route
    app.post('/users', async (req, res) => {
      const user = req.body;
      user.role = 'user'; 
      user.createdAt = new Date();
      const email = user.email;
      const existingUser = await usersCollection.findOne({ email });

      if (existingUser) {
        return res.send({ message: 'User already exists' });
      }
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

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
      const { name, phone, experience, portfolio } = req.body;
      const email = req.tokenEmail;

      console.log('[POST /become-decorator] Request from:', email);
      console.log('[POST /become-decorator] Payload:', { name, phone, experience, portfolio });

      const alreadyExists = await decoratorRequestsCollection.findOne({ email });

      if (alreadyExists) {
        console.log('[409] → Already applied for:', email);
        return res.status(409).send({ message: 'Already applied. Please wait.' });
      }

      const application = {
        name,
        email,
        phone,
        experience,
        portfolio,
        status: 'pending',
        appliedAt: new Date(),
      };

      console.log('[inserting new application] →', application);

      const result = await decoratorRequestsCollection.insertOne(application);

      console.log('[insert success] insertedId:', result.insertedId);

      res.send({ success: true, insertedId: result.insertedId });
    });

    // Daily Revenue (last 30 days)
    app.get('/revenue/daily', verifyJWT, async (req, res) => {
      const adminUser = await usersCollection.findOne({ email: req.tokenEmail });
      if (adminUser?.role !== 'admin') {
        return res.status(403).send({ message: 'Forbidden' });
      }

      try {
        const dailyRevenue = await bookingCollection.aggregate([
          {
            $match: {
              status: 'paid',
              paidAt: { $exists: true }
            }
          },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m-%d", date: "$paidAt" } },
              totalRevenue: { $sum: "$paidAmountUSD" }
            }
          },
          { $sort: { _id: -1 } }, // newest first
          { $limit: 30 } // last 30 days
        ]).toArray();

        res.send(dailyRevenue);
      } catch (err) {
        console.error("Daily revenue error:", err);
        res.status(500).send({ message: 'Error fetching daily revenue' });
      }
    });

    // Monthly Revenue (last 12 months)
    app.get('/revenue/monthly', verifyJWT, async (req, res) => {
      const adminUser = await usersCollection.findOne({ email: req.tokenEmail });
      if (adminUser?.role !== 'admin') {
        return res.status(403).send({ message: 'Forbidden' });
      }

      try {
        const monthlyRevenue = await bookingCollection.aggregate([
          {
            $match: {
              status: 'paid',
              paidAt: { $exists: true }
            }
          },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m", date: "$paidAt" } },
              totalRevenue: { $sum: "$paidAmountUSD" }
            }
          },
          { $sort: { _id: -1 } },
          { $limit: 12 } // last 12 months
        ]).toArray();

        res.send(monthlyRevenue);
      } catch (err) {
        console.error("Monthly revenue error:", err);
        res.status(500).send({ message: 'Error fetching monthly revenue' });
      }
    });

    // Revenue by Service
    app.get('/revenue/by-service', verifyJWT, async (req, res) => {
      const adminUser = await usersCollection.findOne({ email: req.tokenEmail });
      if (adminUser?.role !== 'admin') {
        return res.status(403).send({ message: 'Forbidden' });
      }

      try {
        const serviceRevenue = await bookingCollection.aggregate([
          {
            $match: {
              status: 'paid',
              serviceName: { $exists: true }
            }
          },
          {
            $group: {
              _id: "$serviceName",
              totalRevenue: { $sum: "$paidAmountUSD" }
            }
          },
          { $sort: { totalRevenue: -1 } }, // highest first
          { $limit: 10 } // top 10 services
        ]).toArray();

        res.send(serviceRevenue);
      } catch (err) {
        console.error("Service revenue error:", err);
        res.status(500).send({ message: 'Error fetching service revenue' });
      }
    });


    app.get('/decorator-requests', verifyJWT, async (req, res) => {
      console.log('───────────────────────────────');
      console.log('[GET /decorator-requests] Requested by:', req.tokenEmail);

      const requester = await usersCollection.findOne({ email: req.tokenEmail });

      console.log('[GET /decorator-requests] User document found:',
        requester ? 'YES' : 'NO',
        requester ? `(role: ${requester.role})` : ''
      );

      if (!requester) {
        console.log('[403] → User not found in users collection');
        return res.status(403).send({ message: 'Forbidden' });
      }

      if (requester.role !== 'admin') {
        console.log(`[403] → Role is "${requester.role}" → not admin`);
        return res.status(403).send({ message: 'Forbidden' });
      }

      console.log('[admin check passed] Now querying decoratorRequests...');

      const requests = await decoratorRequestsCollection
        .find({ status: 'pending' })
        .sort({ appliedAt: -1 })
        .toArray();

      console.log('[GET /decorator-requests] Found pending requests:', requests.length);
      if (requests.length > 0) {
        console.log('First request sample:', JSON.stringify(requests[0], null, 2).slice(0, 400) + '...');
      } else {
        console.log('No pending requests found');
      }

      res.send(requests);
    });

    app.patch('/approve-decorator/:email', verifyJWT, async (req, res) => {
      console.log('[PATCH /approve-decorator] Requested by:', req.tokenEmail);
      console.log('[PATCH /approve-decorator] Target email:', req.params.email);
      const adminUser = await usersCollection.findOne({
        email: req.tokenEmail,
      });

      if (adminUser?.role !== 'admin') {
        return res.status(403).send({ message: 'Forbidden' });
      }

      const email = req.params.email;

      // 1️⃣ find user
      const user = await usersCollection.findOne({ email });
      if (!user) {
        return res.status(404).send({ message: 'User not found' });
      }

      // 2️⃣ insert into decorator collection
      await decoratorCollection.insertOne({
        name: user.name || user.displayName || 'Decorator',
        email: user.email,
        createdAt: new Date(),
        active: true,
      });

      // 3️⃣ update user role
      await usersCollection.updateOne(
        { email },
        { $set: { role: 'decorator' } }
      );

      // 4️⃣ update request status
      await decoratorRequestsCollection.updateOne(
        { email },
        { $set: { status: 'approved' } }
      );

      res.send({ success: true });
    });


    app.delete('/reject-decorator/:id', verifyJWT, async (req, res) => {
      const adminUser = await usersCollection.findOne({
        email: req.tokenEmail,
      });

      if (adminUser?.role !== 'admin') {
        return res.status(403).send({ message: 'Forbidden' });
      }

      const id = req.params.id;

      await decoratorRequestsCollection.deleteOne({
        _id: new ObjectId(id),
      });

      res.send({ success: true });
    });




    // payment 

    app.post('/create-booking-session', verifyJWT, async (req, res) => {
      const bookingInfo = req.body;

      const booking = {
        // 🔹 service info
        serviceId: bookingInfo.serviceId,
        serviceName: bookingInfo.serviceName,
        serviceImage: bookingInfo.serviceImage,
        serviceMode: bookingInfo.serviceMode,
        unit: bookingInfo.unit,

        // 🔹 customer info
        customerEmail: req.tokenEmail,
        customerName: bookingInfo.customer?.name || 'Guest',

        // 🔹 booking info
        bookingDate: bookingInfo.bookingDate,
        location: bookingInfo.location,

        // 🔹 pricing
        originalPriceBDT: bookingInfo.originalPriceBDT,
        paidAmountUSD: bookingInfo.price, // USD amount (expected)

        // 🔹 payment
        status: 'unpaid',
        stripeSessionId: null,
        transactionId: null,

        // 🔹 timestamps
        createdAt: new Date(),
        paidAt: null,
      };

      const result = await bookingCollection.insertOne(booking);

      res.send({
        success: true,
        bookingId: result.insertedId,
      });
    });


    // backend/server.js এর মধ্যে run() ফাংশনে যোগ করো

    // backend/server.js এর মধ্যে run() ফাংশনে যোগ করো

    app.get('/check-booking', verifyJWT, async (req, res) => {
      const { serviceId } = req.query;
      const email = req.tokenEmail;

      console.log('[check-booking] Requested by:', email);
      console.log('[check-booking] serviceId:', serviceId);

      if (!serviceId) {
        console.log('[check-booking] No serviceId');
        return res.send({ hasBooked: false });
      }

      try {
        const existing = await bookingCollection.findOne({
          serviceId: serviceId,              // ← string হিসেবে চেক
          customerEmail: email
        });

        console.log('[check-booking] Found:', existing ? 'YES' : 'NO');
        if (existing) {
          console.log('[check-booking] Matched booking:', existing.serviceId, existing.customerEmail);
        }

        res.send({ hasBooked: !!existing });
      } catch (err) {
        console.error('[check-booking] Error:', err);
        res.status(500).send({ hasBooked: false });
      }
    });



app.post('/payment-success', async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).send({ message: 'Session ID required' });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== 'paid') {
      return res.status(400).send({ message: 'Payment not completed' });
    }

    // আগে থেকে unpaid booking খুঁজে দেখো
    const unpaidBooking = await bookingCollection.findOne({
      serviceId: session.metadata.serviceId,
      customerEmail: session.metadata.customerEmail,
      status: 'unpaid'
    });

    if (unpaidBooking) {
      // ১. booking আপডেট করো
      await bookingCollection.updateOne(
        { _id: unpaidBooking._id },
        {
          $set: {
            status: 'paid',
            paidAt: new Date(),
            paidAmountUSD: session.amount_total / 100,
            stripeSessionId: session.id,
            transactionId: session.payment_intent || null
          }
        }
      );

      console.log('Booking updated to paid:', unpaidBooking._id);

      // ২. paymentCollection-এ নতুন ডকুমেন্ট ইনসার্ট করো
      const paymentRecord = {
        bookingId: unpaidBooking._id,
        stripeSessionId: session.id,
        transactionId: session.payment_intent || null,
        customerEmail: session.metadata.customerEmail,
        customerName: session.metadata.customerName || 'Guest',
        serviceId: session.metadata.serviceId,
        serviceName: unpaidBooking.serviceName || 'Unknown',
        serviceImage: unpaidBooking.serviceImage || '',
        amountUSD: session.amount_total / 100,
        originalPriceBDT: Number(session.metadata.originalPriceBDT) || 0,
        paymentStatus: 'paid',
        paidAt: new Date(),
        createdAt: new Date(),
        metadata: session.metadata // extra info যদি লাগে
      };

      const paymentResult = await paymentCollection.insertOne(paymentRecord);
      console.log('Payment record saved in paymentCollection:', paymentResult.insertedId);

      return res.send({ success: true, message: 'Booking confirmed & payment recorded' });
    }

    return res.status(404).send({ message: 'No unpaid booking found for this payment' });

  } catch (error) {
    console.error('Payment success error:', error);
    res.status(500).send({ message: 'Failed to confirm booking' });
  }
});


    app.post('/create-stripe-session', verifyJWT, async (req, res) => {
      const bookingInfo = req.body;
      const baseUrl = process.env.CLIENT_URL || 'http://localhost:5173';

      console.log('[create-stripe-session] Requested by:', req.tokenEmail);
      console.log('[create-stripe-session] Booking info:', bookingInfo);

      if (!bookingInfo.serviceName || !bookingInfo.price) {
        return res.status(400).send({ message: 'Missing required fields (serviceName, price)' });
      }

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
              unit_amount: Math.round(bookingInfo.price * 100), // cents-এ কনভার্ট
            },
            quantity: 1,
          }],
          mode: 'payment',
          success_url: `${baseUrl}/booking-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${baseUrl}/services`,
          metadata: {
            serviceId: bookingInfo.serviceId,
            customerEmail: req.tokenEmail, // verifyJWT থেকে নিরাপদে নেয়া
            customerName: bookingInfo.customer?.name || 'Guest',
            bookingDate: bookingInfo.bookingDate,
            location: bookingInfo.location,
            unit: bookingInfo.unit,
            serviceMode: bookingInfo.serviceMode,
            originalPriceBDT: bookingInfo.originalPriceBDT || bookingInfo.price,
          },
        });

        console.log('[create-stripe-session] Session created:', session.id);

        res.send({ url: session.url });
      } catch (error) {
        console.error('[create-stripe-session] Stripe error:', error);
        res.status(500).send({ message: error.message || 'Payment session creation failed' });
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


    app.get('/top-decorators', async (req, res) => {
      try {
        const decorators = await usersCollection
          .find({ role: 'decorator' })
          .limit(4)
          .toArray();

        res.send(decorators);
      } catch (error) {
        console.error('Error fetching top decorators:', error);
        res.status(500).send({ message: 'Error fetching decorators' });
      }
    });






    // User-এর নিজের bookings দেখার route
    app.get('/my-bookings', verifyJWT, async (req, res) => {
      const email = req.tokenEmail;

      try {
        const bookings = await bookingCollection
          .find({ customerEmail: email })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(bookings);
      } catch (error) {
        console.error('Error fetching my bookings:', error);
        res.status(500).send({ message: 'Failed to load bookings' });
      }
    });

    // User can update their own unpaid booking
// User can update their own unpaid booking
app.patch('/bookings/:id', verifyJWT, async (req, res) => {
  const bookingId = req.params.id.trim(); // extra space বাদ দাও
  const email = req.tokenEmail;
  const updateData = req.body;

  console.log("PATCH /bookings/:id - Received ID:", bookingId);
  console.log("PATCH /bookings/:id - Update data:", updateData);
  console.log("PATCH request by:", email);
  console.log("Trying to edit booking ID:", bookingId);

  if (!ObjectId.isValid(bookingId)) {
    console.log("Invalid ID format:", bookingId);
    return res.status(400).send({ message: 'Invalid booking ID format' });
  }

  const objectId = new ObjectId(bookingId);

  try {
    // ১. booking টা আছে কি না + নিজের কি না চেক করো
    const booking = await bookingCollection.findOne({
      _id: objectId,
      customerEmail: email
    });

    if (!booking) {
      console.log("Booking not found or email mismatch. Found email:", booking?.customerEmail);
      return res.status(404).send({ message: 'Booking not found or not yours' });
    }

    // ২. paid booking edit ব্লক (optional — চাইলে বাদ দিতে পারো)
    if (booking.status === 'paid') {
      console.log("Paid booking edit blocked:", bookingId)
      return res.status(403).send({ message: 'Paid bookings cannot be edited' });
    }

    // ৩. আপডেট করো
    const result = await bookingCollection.updateOne(
      { _id: objectId },
      { $set: updateData }
    );

    console.log("Update result:", result);

    if (result.modifiedCount > 0) {
      res.send({ success: true, message: 'Booking updated successfully' });
    } else {
      res.status(400).send({ message: 'No changes made or update failed' });
    }
  } catch (err) {
    console.error("PATCH /bookings/:id error:", err);
    res.status(500).send({ message: 'Failed to update booking' });
  }
});

    app.delete('/bookings/:id', verifyJWT, async (req, res) => {
      const bookingId = req.params.id;
      const email = req.tokenEmail;

      if (!ObjectId.isValid(bookingId)) {
        return res.status(400).send({ message: 'Invalid booking ID' });
      }

      try {
        // 🔐 user can delete ONLY own booking
        const booking = await bookingCollection.findOne({
          _id: new ObjectId(bookingId),
          customerEmail: email,
        });

        if (!booking) {
          return res.status(404).send({ message: 'Booking not found' });
        }

        // ❗ paid booking delete block (recommended)
        if (booking.status === 'paid') {
          return res.status(403).send({
            message: 'Paid booking cannot be deleted',
          });
        }

        const result = await bookingCollection.deleteOne({
          _id: new ObjectId(bookingId),
        });

        res.send(result);
      } catch (err) {
        console.error('Delete booking error:', err);
        res.status(500).send({ message: 'Failed to delete booking' });
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