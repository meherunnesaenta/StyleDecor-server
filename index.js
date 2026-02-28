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


const allowedOrigins = [
  "http://localhost:5173"
];

app.use(cors());




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
    const decoratorCollection = client.db('styleDecor').collection('decorator')
    const paymentCollection = client.db('styleDecor').collection('payments');
    const trackingCollection = client.db('styleDecor').collection('tracking');

    // verify admin middleware
    const verifyAdmin = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== 'admin' || !user) {
        return res.status(403).send({ message: 'Forbidden' });
      }
      next();
    };
    const verifyDecorator = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== 'decorator' || !user) {
        return res.status(403).send({ message: 'Forbidden' });
      }
      next();
    };


    const logTracking = async (trackingId, status) => {
      const log = {
        trackingId,
        status,
        details: status.split(' - ').join(' '),
        createdAt: new Date()
      }
      const result = await trackingCollection.insertOne(log);
      return result;
    };

    app.post('/service', async (req, res) => {
      const service = req.body;
      const result = await serviceCollection.insertOne(service);
      res.send(result);
    })
     // Public route for home page services
    app.get('/services', async (req, res) => {
    const result = await serviceCollection.find().toArray();
    res.send(result);
    });



    app.get('/servicesort', async (req, res) => {
      const result = await serviceCollection.find().sort({ created_at: -1 }).limit(6).toArray();
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


    // Update a service (PATCH /service/:id)
    app.patch('/service/:id', verifyJWT, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ message: 'Invalid service ID' });
        }

        const updateData = req.body;

        // Optional: যদি কোনো ফিল্ড আপডেট না করতে চাও তাহলে ফিল্টার করতে পারো
        const result = await serviceCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ message: 'Service not found' });
        }

        res.json({
          success: true,
          modifiedCount: result.modifiedCount,
          message: 'Service updated successfully'
        });
      } catch (err) {
        console.error('PATCH /service/:id error:', err);
        res.status(500).json({
          success: false,
          message: 'Failed to update service',
          error: err.message
        });
      }
    });

    // Delete a service (DELETE /service/:id)
    app.delete('/service/:id', verifyJWT, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ message: 'Invalid service ID' });
        }

        const result = await serviceCollection.deleteOne({ _id: new ObjectId(id) });

        if (result.deletedCount === 0) {
          return res.status(404).json({ message: 'Service not found' });
        }

        res.json({
          success: true,
          deletedCount: result.deletedCount,
          message: 'Service deleted successfully'
        });
      } catch (err) {
        console.error('DELETE /service/:id error:', err);
        res.status(500).json({
          success: false,
          message: 'Failed to delete service',
          error: err.message
        });
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


    app.post('/decorator/admin-create', verifyJWT, verifyAdmin, async (req, res) => {
      try {
        const data = req.body || {};

        if (!data.email) {
          return res.status(400).json({
            success: false,
            message: 'Email is required to create decorator'
          });
        }

        const existing = await decoratorCollection.findOne({ email: data.email });
        if (existing) {
          return res.status(409).json({
            success: false,
            message: 'This user is already a decorator'
          });
        }

        const application = {
          name: data.name || 'Unknown',
          email: data.email,
          phone: data.phone || null,
          experience: data.experience || 0,
          portfolio: data.portfolio || null,
          region: data.region || null,
          district: data.district || null,
          area: data.area || null,
          specialization: data.specialization || null,
          bio: data.bio || null,
          status: 'approved',
          workStatus: 'available',
          appliedAt: new Date(),
          userId: data.userId || null,
          createdByAdmin: true,
        };

        const result = await decoratorCollection.insertOne(application);

        res.status(201).json({
          success: true,
          message: 'Decorator created and approved by admin',
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error('[/decorator/admin-create] Error:', error.stack); // full stack trace log
        res.status(500).json({
          success: false,
          message: 'Failed to create decorator entry',
          error: error.message || 'Unknown server error'
        });
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

    app.get('/users/decorator',async(req,res)=>{
      const {role} =req.query;
      const query={};
      if(role){
        query.role =role;
      }
      const result =await usersCollection.find(query).sort({createdAt:-1}).toArray();
      res.send(result);

    })

    app.get('/users/:email/role', async (req, res) => {
      const email = req.params.email;

      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ role: user?.role || 'user' });

    });

    app.patch('/users/:id/role', verifyJWT, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        const { role } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ message: 'Invalid user ID' });
        }

        if (!role) {
          return res.status(400).json({ message: 'Role is required' });
        }

        const query = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            role: role
          }
        };

        const result = await usersCollection.updateOne(query, updateDoc);

        res.json({
          success: true,
          modifiedCount: result.modifiedCount,
          message: `User role updated to ${role}`
        });
      } catch (err) {
        console.error('PATCH /users/:id/role error:', err);
        res.status(500).json({
          success: false,
          message: 'Failed to update user role',
          error: err.message
        });
      }
    });

    app.post('/decorator', verifyJWT, async (req, res) => {
      const {
        fullName,
        phone,
        experience,
        portfolio,
        region,
        district,
        covered_area,
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
          covered_area: covered_area || null,
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


    // Get single decorator application (View details)
    app.get('/decorators/:id', verifyJWT, async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ message: 'Invalid decorator ID' });
        }

        // admin
        const adminUser = await usersCollection.findOne({ email: req.tokenEmail });
        if (!adminUser || adminUser.role !== 'admin') {
          return res.status(403).json({ message: 'Admin access required' });
        }

        const decorator = await decoratorCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!decorator) {
          return res.status(404).json({ message: 'Decorator application not found' });
        }

        res.json(decorator);
      } catch (error) {
        console.error('GET /decorators/:id error:', error);
        res.status(500).json({
          message: 'Failed to load decorator details',
          error: error.message,
        });
      }
    });




    app.patch('/decorators/:id', verifyJWT, async (req, res) => {
      try {
        // ✅ Admin check
        const admin = await usersCollection.findOne({ email: req.tokenEmail });
        if (!admin || admin.role !== 'admin') {
          return res.status(403).json({
            success: false,
            message: 'Only admins can update decorator status'
          });
        }

        const { status } = req.body;
        const { id } = req.params;

        if (!status || !['approved', 'rejected'].includes(status)) {
          return res.status(400).json({
            success: false,
            message: 'Invalid or missing status'
          });
        }

        // ✅ Validate ObjectId
        let objectId;
        try {
          objectId = new ObjectId(id);
        } catch {
          return res.status(400).json({
            success: false,
            message: 'Invalid decorator ID'
          });
        }

        // ✅ STEP 1: find decorator (source of truth)
        const decorator = await decoratorCollection.findOne({ _id: objectId });
        if (!decorator) {
          return res.status(404).json({
            success: false,
            message: 'Decorator request not found'
          });
        }

        // ✅ STEP 2: update decorator status
        const updateDoc = {
          $set: { status }
        };

        if (status === 'approved') {
          updateDoc.$set.workStatus = 'available';
        } else {
          updateDoc.$unset = { workStatus: '' };
        }

        const updateResult = await decoratorCollection.updateOne(
          { _id: objectId },
          updateDoc
        );

        // ✅ STEP 3: sync user role
        if (status === 'approved') {
          await usersCollection.updateOne(
            { email: decorator.email },
            { $set: { role: 'decorator' } }
          );
        } else {
          await usersCollection.updateOne(
            { email: decorator.email },
            { $set: { role: 'user' } }
          );
        }

        return res.json({
          success: true,
          decoratorId: id,
          newStatus: status,
          message: `Decorator ${status} successfully`
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
        const admin = await usersCollection.findOne({ email: req.tokenEmail });
        if (!admin || admin.role !== 'admin') {
          return res.status(403).json({
            success: false,
            message: 'Only admins can delete decorator requests'
          });
        }

        const { id } = req.params;


        let objectId;
        try {
          objectId = new ObjectId(id);
        } catch {
          return res.status(400).json({
            success: false,
            message: 'Invalid decorator ID'
          });
        }

        // ✅ STEP 1: Find decorator FIRST
        const decorator = await decoratorCollection.findOne({ _id: objectId });
        if (!decorator) {
          return res.status(404).json({
            success: false,
            message: 'Decorator request not found'
          });
        }

        // ✅ STEP 2: Delete decorator request
        const deleteResult = await decoratorCollection.deleteOne({ _id: objectId });

        if (deleteResult.deletedCount === 0) {
          return res.status(500).json({
            success: false,
            message: 'Failed to delete decorator request'
          });
        }

        // ✅ STEP 3: Reset user role
        await usersCollection.updateOne(
          { email: decorator.email },
          { $set: { role: 'user' } }
        );

        // ✅ Final response
        return res.json({
          success: true,
          message: 'Decorator request deleted and user role reset to user',
          deletedDecoratorId: id
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




    app.post('/decorators/delete-by-email', verifyJWT, verifyAdmin, async (req, res) => {
      try {
        const { email } = req.body;

        if (!email) {
          return res.status(400).json({ message: 'Email required' });
        }

        const result = await decoratorCollection.deleteOne({ email });

        if (result.deletedCount === 0) {
          return res.status(404).json({ message: 'No decorator found with this email' });
        }

        await usersCollection.updateOne(
          { email },
          { $set: { role: 'user' } }
        );

        res.json({
          success: true,
          message: 'Decorator deleted successfully',
          deletedCount: result.deletedCount,
        });
      } catch (error) {
        console.error('Delete decorator by email error:', error);
        res.status(500).json({ message: 'Server error' });
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
          // ১. booking 
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

          // ২. paymentCollection
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
            metadata: session.metadata
          };
          const trackingId = unpaidBooking._id.toString();
          logTracking(trackingId, 'pending');

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
      const baseUrl = process.env.CLIENT_URL;

      if (!baseUrl) {
        throw new Error('CLIENT_URL is not defined');
      }


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
              unit_amount: Math.round(bookingInfo.price * 100),
            },
            quantity: 1,
          }],
          mode: 'payment',
          success_url: `${process.env.CLIENT_URL}/booking-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.CLIENT_URL}/services`,
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

        const decorator = await decoratorCollection.findOne({ _id: new ObjectId(assignInfo.decoratorId) });
        if (!decorator || decorator.workStatus !== 'available') {
          return res.status(400).json({ message: 'Decorator is not available or not found' });
        }

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

        // Decorator busy 

        await decoratorCollection.updateOne(
          { _id: new ObjectId(assignInfo.decoratorId) },
          { $set: { workStatus: 'busy' } }
        );
        const trackingId = bookingId.toString();
        await logTracking(trackingId, `Assigned to ${assignInfo.decoratorName} - In Progress`);

        if (updateResult.modifiedCount === 0) {
          return res.status(400).json({ message: 'No changes made' });
        }

        res.json({ success: true, modifiedCount: updateResult.modifiedCount });
      } catch (error) {
        console.error('Assign decorator error:', error);
        res.status(500).json({ message: 'Server error while assigning decorator' });
      }
    });



    app.patch('/decorators/:id/work-status', verifyJWT, async (req, res) => {
      try {
        const decoratorId = req.params.id;
        const { workStatus } = req.body;
        const email = req.tokenEmail;

        if (!ObjectId.isValid(decoratorId)) {
          return res.status(400).json({ message: 'Invalid decorator ID' });
        }

        const decorator = await decoratorCollection.findOne({ _id: new ObjectId(decoratorId) });

        if (!decorator) {
          return res.status(404).json({ message: 'Decorator not found' });
        }

        const isAdmin = await usersCollection.findOne({ email, role: 'admin' });
        if (decorator.email !== email && !isAdmin) {
          return res.status(403).json({ message: 'You can only update your own work status' });
        }

        const updateResult = await decoratorCollection.updateOne(
          { _id: new ObjectId(decoratorId) },
          { $set: { workStatus } }
        );

        if (updateResult.modifiedCount === 0) {
          return res.status(400).json({ message: 'No changes made' });
        }

        res.json({ success: true, message: `Work status updated to ${workStatus}` });
      } catch (error) {
        console.error('Update decorator work status error:', error);
        res.status(500).json({ message: 'Server error' });
      }
    });

    app.post('/bookings/:id/cashout', verifyJWT, async (req, res) => {
      try {
        const bookingId = req.params.id;
        const email = req.tokenEmail;

        const booking = await bookingCollection.findOne({ _id: new ObjectId(bookingId) });

        if (!booking || booking.decoratorEmail !== email) {
          return res.status(403).json({ message: 'Not authorized' });
        }

        if (booking.workStatus !== 'completed') {
          return res.status(400).json({ message: 'Project not completed yet' });
        }

        await bookingCollection.updateOne(
          { _id: new ObjectId(bookingId) },
          { $set: { cashedOut: true, cashedOutAt: new Date() } }
        );


        res.json({ success: true, message: 'Cash out requested successfully' }); const trackingId = bookingId.toString();
        await logTracking(trackingId, 'Project Completed & Cashout Requested');
      } catch (error) {
        res.status(500).json({ message: 'Server error' });
      }
    });




    app.get('/work-status/starts', async (req, res) => {
      const pipeline = [
        {
          $group: {
            _id: '$workStatus',
            count: { $sum: 1 }
          }
        }
      ];
      const result = await bookingCollection.aggregate(pipeline).toArray();
      res.send(result);
    });



    app.get('/decorator/work-per-day', verifyJWT, async (req, res) => {
      try {
        const decoratorEmail = req.tokenEmail

        if (!decoratorEmail) {
          return res.status(400).send({ message: 'Decorator email is required' });
        }

        const pipeline = [
          // 1️⃣ Match decorator + completed work
          {
            $match: {
              decoratorEmail,
              workStatus: 'completed',
            },
          },

          // 2️⃣ Lookup tracking collection
          {
            $lookup: {
              from: 'tracking',
              localField: '_id',          // bookings._id
              foreignField: 'trackingId', // tracking.trackingId
              as: 'trackingInfo',
            },
          },

          // 3️⃣ Match tracking status inside array
          {
            $match: {
              'trackingInfo': {
                $elemMatch: { status: 'Project Completed & Cashout Requested' }
              }
            }
          },

          // 4️⃣ Add completedDate (YYYY-MM-DD)
          {
            $addFields: {
              completedDate: { $dateToString: { format: '%Y-%m-%d', date: '$assignedAt' } },
            },
          },

          // 5️⃣ Group by date
          {
            $group: {
              _id: '$completedDate',
              count: { $sum: 1 },
            },
          },

          // 6️⃣ Sort by date
          {
            $sort: { _id: 1 },
          },
        ];

        const result = await bookingCollection.aggregate(pipeline).toArray();
        res.send(result);

      } catch (error) {
        console.error('work-per-day error:', error);
        res.status(500).send({ message: 'Server error' });
      }
    });





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
app.get('/bookings/decorator', verifyJWT, verifyDecorator, async (req, res) => {
  const { decoratorEmail, workStatus } = req.query;

  if (decoratorEmail !== req.tokenEmail) {
    return res.status(403).send({ message: "Forbidden" });
  }

  const query = { decoratorEmail };

  if (workStatus) {
    query.workStatus = { $in: workStatus.split(',') };
  }

  const result = await bookingCollection
    .find(query)
    .sort({ createdAt: -1 })
    .toArray();

  res.send(result);
});







    app.patch('/bookings/:id/decorator-status', verifyJWT, async (req, res) => {
      try {
        const bookingId = req.params.id;
        const { workStatus } = req.body;
        const email = req.tokenEmail;

        if (!ObjectId.isValid(bookingId)) {
          return res.status(400).json({ message: 'Invalid booking ID' });
        }

        const booking = await bookingCollection.findOne({ _id: new ObjectId(bookingId) });

        if (!booking) {
          return res.status(404).json({ message: 'Booking not found' });
        }

        if (booking.decoratorEmail !== email) {
          return res.status(403).json({ message: 'This booking is not assigned to you' });
        }

        const allowedStatuses = ['in-progress', 'materials-prepared', 'completed', 'rejected'];
        if (!allowedStatuses.includes(workStatus)) {
          return res.status(400).json({ message: 'Invalid status update' });
        }

        const updateResult = await bookingCollection.updateOne(
          { _id: new ObjectId(bookingId) },
          { $set: { workStatus } }
        );

        if (updateResult.modifiedCount > 0) {
          // Tracking log যোগ করা হলো
          const trackingId = bookingId.toString();
          await logTracking(trackingId, `Work Status Updated to ${workStatus}`, {
            updatedBy: email,
            previousStatus: booking.workStatus || 'assigned'
          });

          // যদি completed বা rejected হয়, তাহলে decorator available করো
          if (workStatus === 'completed' || workStatus === 'rejected') {
            await decoratorCollection.updateOne(
              { _id: new ObjectId(booking.decoratorId) },
              { $set: { workStatus: 'available' } }
            );
          }

          res.json({ success: true, modifiedCount: updateResult.modifiedCount });
        } else {
          res.status(400).json({ message: 'No changes made' });
        }
      } catch (error) {
        console.error('Decorator status update error:', error);
        res.status(500).json({ message: 'Server error' });
      }
    });


app.patch('/bookings/:id', verifyJWT, async (req, res) => {
  const bookingId = req.params.id.trim();
  const email = req.tokenEmail;
  const updateData = req.body;

  if (!ObjectId.isValid(bookingId)) {
    return res.status(400).send({ message: 'Invalid booking ID format' });
  }

  const objectId = new ObjectId(bookingId);

  try {
    const booking = await bookingCollection.findOne({
      _id: objectId,
      customerEmail: email
    });

    if (!booking) {
      return res.status(404).send({ message: 'Booking not found or not yours' });
    }

    if (booking.status === 'paid') {
      return res.status(403).send({ message: 'Paid bookings cannot be edited' });
    }

    const result = await bookingCollection.updateOne(
      { _id: objectId },
      { $set: updateData }
    );

    if (result.modifiedCount > 0) {
      await logTracking(bookingId, 'Booking Updated by Customer', {
        updatedBy: email,
        changes: updateData
      });

      res.send({ success: true, message: 'Booking updated successfully' });
    } else {
      res.status(400).send({ message: 'No changes made or update failed' });
    }
  } catch (err) {
    console.error("PATCH /bookings/:id error:", err);
    res.status(500).send({ message: 'Failed to update booking' });
  }
});


    app.get('/trackings/:trackingId/logs', async (req, res) => {
      const trackingId = req.params.trackingId;
      try {
        const logs = await trackingCollection
          .find({ trackingId })
          .sort({ createdAt: 1 })
          .toArray();
        res.send(logs);
      } catch (err) {
        res.status(500).send({ message: 'Failed to fetch tracking logs' });
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
    // await client.db("admin").command({ ping: 1 });
    // console.log("Pinged your deployment. You successfully connected to MongoDB!");
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