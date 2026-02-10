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


  if (!token) {
    console.log('[verifyJWT] → 401 No token');
    return res.status(401).send({ message: 'Unauthorized Access!' });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;

    next();
  } catch (err) {

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

    // verify admin middleware
    const verifyAdmin = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== 'admin' || !user) {
        return res.status(403).send({ message: 'Forbidden' });
      }
      next();
    };
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



    app.get('/manage-bookings', verifyJWT, verifyAdmin, async (req, res) => {
      const query = {};
      const { email } = req.query;
      if (email) {
        query.customerEmail = email;
      }
      const options = { sort: { createdAt: -1 } };
      const cursor = bookingCollection.find(query, options);
      const bookings = await cursor.toArray();
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

    app.get('/users', async (req, res) => {
      const searchText = req.query.searchText;
      const query = {};

      if (searchText) {

        query.$or = [
          { displayName: { $regex: searchText, $options: 'i' } },
          { email: { $regex: searchText, $options: 'i' } },
        ]

      }

      const cursor = usersCollection.find(query).sort({ createdAt: -1 }).limit(5);
      const result = await cursor.toArray();
      res.send(result);
    })

    app.get('/users/:email/role', async (req, res) => {
      const email = req.params.email;

      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ role: user?.role || 'user' });

    });

    app.patch('/users/:id/role', verifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const { role } = req.body;
      const quey = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          role: role
        }
      }
      const result = await usersCollection.updateOne(quey, updateDoc);
      res.send(result);
    })


    // Become Decorator Application (User applies to become decorator)
    app.post('/decorator', verifyJWT, async (req, res) => {
      const {
        fullName,
        phone,
        experience,
        portfolio,
        region,
        district,
        specialization,
        bio
      } = req.body;

      const email = req.tokenEmail;

      try {

        const alreadyApplied = await decoratorCollection.findOne({ email });

        if (alreadyApplied) {
          return res.status(409).send({
            success: false,
            message: 'You have already submitted an application. Please wait for review.'
          });
        }

        const application = {
          name: fullName || 'Unknown',
          email,
          phone: phone || null,
          experience: Number(experience) || 0,
          portfolio: portfolio || null,
          region: region || null,
          district: district || null,
          specialization: specialization || null,
          bio: bio || null,
          status: 'pending',
          appliedAt: new Date(),
          userId: req.user?.uid || null
        };

        const result = await decoratorCollection.insertOne(application);

        console.log(`New decorator application from ${email}:`, result.insertedId);

        res.status(201).send({
          success: true,
          message: 'Application submitted successfully!',
          insertedId: result.insertedId
        });
      } catch (error) {
        console.error('Become decorator error:', error);
        res.status(500).send({
          success: false,
          message: 'Failed to submit application. Please try again later.'
        });
      }
    });

    app.get('/decorators', async (req, res) => {
      const query = {};
      if (req.query.region) {
        query.status = req.query.status;
      }
      const cursor = decoratorCollection.find(query).sort({ appliedAt: -1 });
      const decorators = await cursor.toArray();
      res.send(decorators);
    });



    app.patch('/decorators/:id', verifyJWT, async (req, res) => {
  try {
    const admin = await usersCollection.findOne({ email: req.tokenEmail });
    if (!admin || admin.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can update decorator status' });
    }

    const { status, email } = req.body;
    const id = req.params.id;

    if (!status || !['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid or missing status' });
    }

    if (!email) {
      return res.status(400).json({ message: 'Email is required in request body' });
    }

    let objectId;
    try {
      objectId = new ObjectId(id);
    } catch (err) {
      return res.status(400).json({ message: 'Invalid decorator ID format' });
    }

    // Decorator আপডেট
    const updateDoc = {
      $set: {
        status: status,
      }
    };

    // Approved হলে workStatus 'available' করে দাও (এটাই মূল পরিবর্তন)
    if (status === 'approved') {
      updateDoc.$set.workStatus = 'available';
    }

    const updateResult = await decoratorCollection.updateOne(
      { _id: objectId },
      updateDoc
    );

    if (updateResult.matchedCount === 0) {
      return res.status(404).json({ message: 'Decorator request not found' });
    }

    // Approved হলে user role আপডেট
    let userUpdateResult = null;
    if (status === 'approved') {
      userUpdateResult = await usersCollection.updateOne(
        { email: email },
        { $set: { role: 'decorator' } }
      );
    }

    return res.json({
      success: true,
      modifiedCount: updateResult.modifiedCount,
      userUpdated: status === 'approved' ? (userUpdateResult?.modifiedCount > 0) : false,
      message: `Decorator status updated to ${status}`
    });

  } catch (error) {
    console.error('PATCH /decorators/:id error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error while updating decorator status',
      error: error.message
    });
  }
});



    app.delete('/decorators/:id', verifyJWT, async (req, res) => {
      try {
        // Admin চেক (অন্যথায় যে কেউ delete করতে পারবে)
        const admin = await usersCollection.findOne({ email: req.tokenEmail });
        if (!admin || admin.role !== 'admin') {
          return res.status(403).json({ message: 'Only admins can delete decorator requests' });
        }

        const id = req.params.id;

        let objectId;
        try {
          objectId = new ObjectId(id);
        } catch (err) {
          return res.status(400).json({ message: 'Invalid ID format' });
        }

        const deleteResult = await decoratorCollection.deleteOne({ _id: objectId });

        if (deleteResult.deletedCount === 0) {
          return res.status(404).json({ message: 'Decorator request not found' });
        }

        return res.json({
          success: true,
          message: 'Decorator request deleted successfully',
          deletedCount: deleteResult.deletedCount
        });

      } catch (error) {
        console.error('DELETE /decorators/:id error:', error);
        return res.status(500).json({
          success: false,
          message: 'Server error while deleting decorator request',
          error: error.message
        });
      }
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
        workStatus: 'pending',

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
          serviceId: serviceId,
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
                transactionId: session.payment_intent || null,
                workStatus: 'pending'
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
            customerEmail: req.tokenEmail,
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


    // ১. Assign decorator to booking
    app.patch('/bookings/:id/assign-decorator', verifyJWT, verifyAdmin, async (req, res) => {
  try {
    const bookingId = req.params.id;
    const assignInfo = req.body;

    if (!ObjectId.isValid(bookingId)) {
      return res.status(400).json({ message: 'Invalid booking ID' });
    }

    const booking = await bookingCollection.findOne({ _id: new ObjectId(bookingId) });

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    if (booking.decoratorId) {
      return res.status(400).json({ message: 'Decorator already assigned' });
    }

    // চেক করো decorator available আছে কি না (অতিরিক্ত নিরাপত্তা)
    const decorator = await decoratorCollection.findOne({ _id: new ObjectId(assignInfo.decoratorId) });
    if (!decorator || decorator.workStatus !== 'available') {
      return res.status(400).json({ message: 'Decorator is not available or not found' });
    }

    // Booking update
    const updateResult = await bookingCollection.updateOne(
      { _id: new ObjectId(bookingId) },
      {
        $set: {
          decoratorId: assignInfo.decoratorId,
          decoratorEmail: assignInfo.decoratorEmail,
          decoratorName: assignInfo.decoratorName,
          assignedAt: assignInfo.assignedAt,
          workStatus: 'assigned'
        }
      }
    );

    // Decorator busy করো (এটাই মূল ফিক্স!)
    await decoratorCollection.updateOne(
      { _id: new ObjectId(assignInfo.decoratorId) },
      { $set: { workStatus: 'busy' } }
    );

    if (updateResult.modifiedCount === 0) {
      return res.status(400).json({ message: 'No changes made' });
    }

    res.json({ success: true, modifiedCount: updateResult.modifiedCount });
  } catch (error) {
    console.error('Assign decorator error:', error);
    res.status(500).json({ message: 'Server error while assigning decorator' });
  }
});

    // Decorator-এর workStatus update route
app.patch('/decorators/:id/work-status', verifyJWT, verifyAdmin, async (req, res) => {
  try {
    const decoratorId = req.params.id;
    const { workStatus } = req.body;

    if (!ObjectId.isValid(decoratorId)) {
      return res.status(400).json({ message: 'Invalid decorator ID' });
    }

    const updateResult = await decoratorCollection.updateOne(
      { _id: new ObjectId(decoratorId) },
      { $set: { workStatus } }
    );

    if (updateResult.modifiedCount === 0) {
      return res.status(404).json({ message: 'Decorator not found or no changes' });
    }

    res.json({ success: true, message: `Work status updated to ${workStatus}` });
  } catch (error) {
    console.error('Update decorator work status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

    // ২. Decorator-এর workStatus update (optional কিন্তু তোমার কোডে আছে)
    app.patch('/decorators/:id/work-status', verifyJWT, verifyAdmin, async (req, res) => {
      try {
        const decoratorId = req.params.id;
        const { workStatus } = req.body;

        if (!ObjectId.isValid(decoratorId)) {
          return res.status(400).json({ message: 'Invalid decorator ID' });
        }

        const updateResult = await decoratorCollection.updateOne(
          { _id: new ObjectId(decoratorId) },
          { $set: { workStatus } }
        );

        if (updateResult.modifiedCount === 0) {
          return res.status(400).json({ message: 'No changes made or decorator not found' });
        }

        res.json({ success: true, message: `Decorator work status updated to ${workStatus}` });
      } catch (error) {
        console.error('Update decorator work status error:', error);
        res.status(500).json({ message: 'Server error' });
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