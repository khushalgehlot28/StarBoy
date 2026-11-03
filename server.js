const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const { rateLimit } = require('express-rate-limit');
const Razorpay = require('razorpay');
const path = require('path');
const crypto = require('crypto');
const Product = require('./models/Product');
const Order = require('./models/Order');
const Review = require('./models/Review');

dotenv.config();

const app = express();
if (process.env.VERCEL) app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }
}));
const defaultJsonParser = express.json({ limit: '10kb' });
const reviewJsonParser = express.json({ limit: '350kb' });
app.use((req, res, next) => {
  const parser = req.method === 'POST' && req.path === '/api/reviews'
    ? reviewJsonParser
    : defaultJsonParser;
  parser(req, res, next);
});
app.use(mongoSanitize());
app.use(cors());
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-8',
  legacyHeaders: false
}));

// Serve static files correctly using absolute paths for Vercel
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const razorpay = RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET
  ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
  : null;

const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false
});
const checkoutRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false
});

function validateStartupConfig() {
  const missing = [];
  if (!MONGO_URI) missing.push('MONGO_URI');
  if (!JWT_SECRET || Buffer.byteLength(JWT_SECRET, 'utf8') < 32) missing.push('JWT_SECRET (at least 32 bytes)');
  if (!ADMIN_USER) missing.push('ADMIN_USER');
  if (!ADMIN_PASS) missing.push('ADMIN_PASS');
  if (!RAZORPAY_KEY_ID) missing.push('RAZORPAY_KEY_ID');
  if (!RAZORPAY_KEY_SECRET) missing.push('RAZORPAY_KEY_SECRET');
  if (missing.length) {
    throw new Error(`Missing or invalid required environment variables: ${missing.join(', ')}`);
  }
}

function isAdminAuthConfigured() {
  return Boolean(ADMIN_USER && ADMIN_PASS && JWT_SECRET && Buffer.byteLength(JWT_SECRET, 'utf8') >= 32);
}

let mongoConnectionPromise = null;

async function connectDB() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (!MONGO_URI) {
    throw new Error('MONGO_URI is not defined in environment variables.');
  }
  if (!mongoConnectionPromise) {
    mongoConnectionPromise = mongoose.connect(MONGO_URI, {
      bufferCommands: false,
      family: 4,
      serverSelectionTimeoutMS: 5000
    }).then(() => mongoose.connection).catch(error => {
      mongoConnectionPromise = null;
      throw error;
    });
  }
  return mongoConnectionPromise;
}

mongoose.connection.on('disconnected', () => {
  mongoConnectionPromise = null;
  console.warn('MongoDB disconnected; the next request will reconnect.');
});
mongoose.connection.on('error', error => {
  console.error('MongoDB connection error:', error.message);
});

function getPincodeServiceability(pincode) {
  const parsePrefixes = setting => setting.split(',').map(prefix => prefix.trim()).filter(Boolean);
  const serviceablePrefixes = parsePrefixes(process.env.SERVICEABLE_PIN_PREFIXES || '');
  const codPrefixes = parsePrefixes(process.env.COD_PIN_PREFIXES || '');
  if ([...serviceablePrefixes, ...codPrefixes].some(prefix => !/^\d{1,6}$/.test(prefix))) {
    return { error: 'PIN code serviceability is misconfigured. Please contact us.' };
  }
  const rawEstimateDays = process.env.DELIVERY_ESTIMATE_DAYS || '';
  const estimateDays = /^\d+$/.test(rawEstimateDays) ? Number(rawEstimateDays) : null;
  const configured = serviceablePrefixes.length > 0;
  const serviceable = serviceablePrefixes.some(prefix => pincode.startsWith(prefix));
  return {
    configured,
    serviceable,
    codAvailable: serviceable && codPrefixes.some(prefix => pincode.startsWith(prefix)),
    estimateDays: serviceable && Number.isInteger(estimateDays) && estimateDays > 0 ? estimateDays : null
  };
}

function validateCustomerDetails(body) {
  const { customerName, phone, address, pincode } = body || {};
  if (typeof customerName !== 'string' || customerName.trim().length < 2 || customerName.length > 100
    || typeof phone !== 'string' || !/^[+\d\s()-]{8,20}$/.test(phone)
    || typeof address !== 'string' || address.trim().length < 5 || address.length > 500
    || typeof pincode !== 'string' || !/^\d{6}$/.test(pincode)) {
    return 'Enter valid customer and delivery details.';
  }
  return '';
}

async function priceCart(items) {
  if (!Array.isArray(items) || !items.length || items.length > 30) {
    return { error: 'Add at least one valid cart item.' };
  }

  const quantitiesById = new Map();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || !mongoose.isValidObjectId(item.productId)
      || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20
      || !['A4', 'A3'].includes(item.size)
      || !['Unframed', 'Framed'].includes(item.frame)) {
      return { error: 'One or more cart items are invalid. Please refresh your cart and try again.' };
    }
    const productId = String(item.productId).toLowerCase();
    const quantity = (quantitiesById.get(productId) || 0) + item.quantity;
    if (quantity > 20) {
      return { error: 'A product cannot exceed 20 total items per order.' };
    }
    quantitiesById.set(productId, quantity);
  }

  await connectDB();
  const products = await Product.find({
    _id: { $in: [...quantitiesById.keys()] },
    inStock: { $ne: false }
  });
  if (products.length !== quantitiesById.size) {
    return { error: 'One or more products are unavailable. Please refresh your cart.' };
  }

  const productsById = new Map(products.map(product => [String(product._id).toLowerCase(), product]));
  const orderItems = items.map(requested => {
    const product = productsById.get(String(requested.productId).toLowerCase());
    return {
      productId: product._id,
      title: product.title,
      image: product.image,
      price: product.price,
      quantity: requested.quantity,
      size: requested.size,
      frame: requested.frame
    };
  });
  const rawTotal = orderItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
  if (!Number.isFinite(rawTotal) || !Number.isSafeInteger(Math.round(rawTotal * 100))) {
    return { error: 'The cart total is outside the supported payment range.' };
  }
  const total = Math.round(rawTotal * 100) / 100;
  return { orderItems, total };
}

// Admin Authentication Route
app.post('/api/admin/login', loginRateLimit, (req, res) => {
  if (!isAdminAuthConfigured()) {
    return res.status(503).json({ error: 'Admin authentication is not configured on the server.' });
  }

  const { username, password } = req.body || {};

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = jwt.sign({ username: ADMIN_USER, isAdmin: true }, JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: '1h'
    });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Invalid admin credentials' });
});

function verifyAdmin(req, res, next) {
  if (!isAdminAuthConfigured()) {
    return res.status(503).json({ error: 'Admin authentication is not configured on the server.' });
  }

  const [scheme, token] = (req.get('authorization') || '').trim().split(/\s+/);
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'A valid admin token is required.' });
  }

  jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }, (err, user) => {
    if (err || !user || user.username !== ADMIN_USER || user.isAdmin !== true) {
      return res.status(403).json({ error: 'Invalid or expired admin token.' });
    }

    req.admin = user;
    next();
  });
}

// Get All Products (Public)
app.get('/api/products', async (req, res) => {
  try {
    await connectDB();
    const products = await Product.find({});
    res.json(products);
  } catch (err) {
    console.error('Error fetching products:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/share/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(404);
  try {
    await connectDB();
    const product = await Product.findById(req.params.id);
    if (!product) return res.sendStatus(404);
    const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
    const protocol = (req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim();
    const host = (req.get('x-forwarded-host') || req.get('host')).split(',')[0].trim();
    const baseUrl = new URL(process.env.PUBLIC_SITE_URL || `${protocol}://${host}`).origin;
    const previewUrl = new URL(product.image, `${baseUrl}/`).toString();
    if (!['http:', 'https:'].includes(new URL(previewUrl).protocol)) return res.sendStatus(400);
    const destination = `/products.html?product=${encodeURIComponent(String(product._id))}`;
    const shareUrl = new URL(`/share/${encodeURIComponent(String(product._id))}`, `${baseUrl}/`).toString();
    const title = `${product.title} | Starboy Crafted`;
    const description = `Explore ${product.title} from Starboy Crafted, priced at ₹${product.price}.`;
    res.type('html').send(`<!DOCTYPE html>
      <html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
      <title>${escapeHtml(title)}</title>
      <meta name="description" content="${escapeHtml(description)}">
      <meta property="og:type" content="product"><meta property="og:title" content="${escapeHtml(title)}">
      <meta property="og:description" content="${escapeHtml(description)}">
      <link rel="canonical" href="${escapeHtml(shareUrl)}">
      <meta property="og:url" content="${escapeHtml(shareUrl)}">
      <meta property="og:image" content="${escapeHtml(previewUrl)}">
      <meta name="twitter:card" content="summary_large_image">
      <meta http-equiv="refresh" content="0;url=${escapeHtml(destination)}">
      </head><body><p>Opening <a href="${escapeHtml(destination)}">${escapeHtml(product.title)}</a>…</p>
      <script>window.location.replace(${JSON.stringify(destination)})</script></body></html>`);
  } catch (err) {
    console.error('Error generating product share preview:', err.message);
    res.status(500).send('Product preview is temporarily unavailable.');
  }
});

app.post('/api/serviceability', (req, res) => {
  const { pincode } = req.body || {};
  if (typeof pincode !== 'string' || !/^\d{6}$/.test(pincode)) {
    return res.status(400).json({ error: 'Enter a valid 6-digit PIN code.' });
  }

  const result = getPincodeServiceability(pincode);
  if (result.error) return res.status(503).json({ error: result.error });
  if (!result.configured) {
    return res.json({
      configured: false,
      message: 'Delivery availability and COD for this PIN need confirmation. Please contact us.'
    });
  }
  return res.json(result);
});

app.post('/api/orders', checkoutRateLimit, async (req, res) => {
  try {
    const body = req.body || {};
    const { customerName, phone, address, pincode } = body;
    const detailsError = validateCustomerDetails(body);
    if (detailsError) return res.status(400).json({ error: detailsError });
    const delivery = getPincodeServiceability(pincode);
    if (delivery.error) return res.status(503).json({ error: delivery.error });
    if (delivery.configured && !delivery.serviceable) {
      return res.status(400).json({ error: 'Delivery is not currently available for this PIN code.' });
    }

    const pricedCart = await priceCart(body.items);
    if (pricedCart.error) return res.status(400).json({ error: pricedCart.error });
    const order = await Order.create({
      orderId: `SB-${crypto.randomBytes(10).toString('hex').toUpperCase()}`,
      customerName: customerName.trim(),
      phone: phone.trim(),
      address: address.trim(),
      pincode,
      items: pricedCart.orderItems,
      total: pricedCart.total
    });
    res.status(201).json({ orderId: order.orderId, total: order.total, status: order.status });
  } catch (err) {
    console.error('Error creating order:', err.message);
    res.status(500).json({ error: 'We could not save your order request. Please try WhatsApp again.' });
  }
});

app.post('/api/payments/create-order', checkoutRateLimit, async (req, res) => {
  if (!razorpay) {
    return res.status(503).json({ error: 'Online payments are not configured. Please use WhatsApp checkout.' });
  }
  try {
    const body = req.body || {};
    const { customerName, phone, address, pincode } = body;
    const detailsError = validateCustomerDetails(body);
    if (detailsError) return res.status(400).json({ error: detailsError });
    const delivery = getPincodeServiceability(pincode);
    if (delivery.error) return res.status(503).json({ error: delivery.error });
    if (delivery.configured && !delivery.serviceable) {
      return res.status(400).json({ error: 'Delivery is not currently available for this PIN code.' });
    }

    const pricedCart = await priceCart(body.items);
    if (pricedCart.error) return res.status(400).json({ error: pricedCart.error });
    const amount = Math.round(pricedCart.total * 100);
    if (!Number.isSafeInteger(amount) || amount < 100) {
      return res.status(400).json({ error: 'The cart total is below the minimum online payment amount.' });
    }

    const orderId = `SB-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
    const gatewayOrder = await razorpay.orders.create({
      amount,
      currency: 'INR',
      receipt: orderId,
      notes: { storeOrderId: orderId }
    });
    if (!gatewayOrder || typeof gatewayOrder.id !== 'string'
      || gatewayOrder.amount !== amount || gatewayOrder.currency !== 'INR') {
      throw new Error('Razorpay returned an invalid order response.');
    }
    const order = await Order.create({
      orderId,
      customerName: customerName.trim(),
      phone: phone.trim(),
      address: address.trim(),
      pincode,
      items: pricedCart.orderItems,
      total: pricedCart.total,
      paymentStatus: 'Pending',
      razorpayOrderId: gatewayOrder.id
    });
    res.status(201).json({
      keyId: RAZORPAY_KEY_ID,
      razorpayOrderId: gatewayOrder.id,
      orderId: order.orderId,
      amount: gatewayOrder.amount,
      currency: gatewayOrder.currency,
      customerName: order.customerName,
      phone: order.phone
    });
  } catch (err) {
    console.error('Error creating Razorpay order:', err.message);
    res.status(502).json({ error: 'We could not start online payment. Please try WhatsApp checkout.' });
  }
});

app.post('/api/payments/verify', checkoutRateLimit, async (req, res) => {
  if (!razorpay) {
    return res.status(503).json({ error: 'Online payments are not configured.' });
  }
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (typeof razorpay_order_id !== 'string' || typeof razorpay_payment_id !== 'string'
    || typeof razorpay_signature !== 'string' || !/^[a-f0-9]{64}$/i.test(razorpay_signature)) {
    return res.status(400).json({ error: 'Payment verification details are invalid.' });
  }

  const expectedSignature = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest();
  const receivedSignature = Buffer.from(razorpay_signature, 'hex');
  if (expectedSignature.length !== receivedSignature.length
    || !crypto.timingSafeEqual(expectedSignature, receivedSignature)) {
    return res.status(400).json({ error: 'Payment signature could not be verified.' });
  }

  try {
    await connectDB();
    const order = await Order.findOne({ razorpayOrderId: razorpay_order_id });
    if (!order) return res.status(404).json({ error: 'The payment order could not be found.' });
    if (order.paymentStatus === 'Paid') {
      if (order.razorpayPaymentId === razorpay_payment_id) {
        return res.json({ orderId: order.orderId, paymentStatus: order.paymentStatus });
      }
      return res.status(409).json({ error: 'This order has already been paid.' });
    }

    let payment = await razorpay.payments.fetch(razorpay_payment_id);
    if (payment.order_id !== razorpay_order_id || payment.amount !== Math.round(order.total * 100)
      || payment.currency !== 'INR') {
      return res.status(400).json({ error: 'The payment details do not match this order.' });
    }
    if (payment.status === 'authorized') {
      payment = await razorpay.payments.capture(payment.id, payment.amount, payment.currency);
    }
    if (payment.status !== 'captured') {
      return res.status(400).json({ error: 'The payment is not captured for this order.' });
    }
    order.paymentStatus = 'Paid';
    order.razorpayPaymentId = razorpay_payment_id;
    await order.save();
    res.json({ orderId: order.orderId, paymentStatus: order.paymentStatus });
  } catch (err) {
    console.error('Error verifying Razorpay payment:', err.message);
    res.status(500).json({ error: 'Payment verification is temporarily unavailable.' });
  }
});

app.post('/api/orders/track', async (req, res) => {
  try {
    const orderId = String((req.body || {}).orderId || '').trim().toUpperCase();
    if (!/^SB-[A-F0-9]{20}$/.test(orderId)) {
      return res.status(400).json({ error: 'Enter the full order ID in the format SB-….' });
    }
    await connectDB();
    const order = await Order.findOne({ orderId }).select('orderId status createdAt updatedAt');
    if (!order) return res.status(404).json({ error: 'We could not find an order with that ID.' });
    res.json({ orderId: order.orderId, status: order.status, createdAt: order.createdAt, updatedAt: order.updatedAt });
  } catch (err) {
    console.error('Error tracking order:', err.message);
    res.status(500).json({ error: 'Order tracking is temporarily unavailable. Please try again later.' });
  }
});

app.get('/api/reviews', async (req, res) => {
  try {
    await connectDB();
    const reviews = await Review.find({ approved: true }).sort({ createdAt: -1 }).limit(20)
      .select('customerName rating message photo createdAt');
    res.json(reviews);
  } catch (err) {
    console.error('Error fetching reviews:', err.message);
    res.status(500).json({ error: 'Reviews are temporarily unavailable.' });
  }
});

app.get('/api/admin/products', verifyAdmin, async (req, res) => {
  try {
    await connectDB();
    const products = await Product.find({}).sort({ createdAt: -1 });
    res.json(products);
  } catch (err) {
    console.error('Error fetching admin products:', err.message);
    res.status(500).json({ error: 'Products could not be loaded.' });
  }
});

function validateProductInput(input, partial = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Provide product details.' };
  }
  const allowedFields = new Set(['title', 'category', 'price', 'originalPrice', 'discount', 'badge', 'image', 'inStock']);
  if (Object.keys(input).some(key => !allowedFields.has(key))) {
    return { error: 'One or more product fields are not supported.' };
  }
  const fields = Object.keys(input);
  if (!partial && ['title', 'category', 'price', 'image'].some(key => !(key in input))) {
    return { error: 'Title, category, price, and image are required.' };
  }
  const product = {};
  for (const field of fields) {
    const value = input[field];
    if (['title', 'category', 'discount', 'badge', 'image'].includes(field)) {
      if (typeof value !== 'string' || (['title', 'category', 'image'].includes(field) && !value.trim())) {
        return { error: `Enter a valid ${field}.` };
      }
      product[field] = value.trim();
    } else if (field === 'price' || field === 'originalPrice') {
      if (field === 'originalPrice' && value === null) {
        product[field] = null;
      } else if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return { error: `Enter a valid ${field}.` };
      } else {
        product[field] = value;
      }
    } else if (field === 'inStock') {
      if (typeof value !== 'boolean') return { error: 'Stock status must be true or false.' };
      product[field] = value;
    }
  }
  return { product };
}

app.post('/api/admin/products', verifyAdmin, async (req, res) => {
  const validated = validateProductInput(req.body);
  if (validated.error) return res.status(400).json({ error: validated.error });
  try {
    await connectDB();
    const product = await Product.create(validated.product);
    res.status(201).json(product);
  } catch (err) {
    console.error('Error creating admin product:', err.message);
    res.status(err.name === 'ValidationError' ? 400 : 500).json({
      error: err.name === 'ValidationError' ? 'Product details are invalid.' : 'Product could not be created.'
    });
  }
});

app.put('/api/admin/products/:id', verifyAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Product ID is invalid.' });
  const validated = validateProductInput(req.body, true);
  if (validated.error || !Object.keys(validated.product || {}).length) {
    return res.status(400).json({ error: validated.error || 'Provide at least one product field to update.' });
  }
  try {
    await connectDB();
    const product = await Product.findByIdAndUpdate(req.params.id, validated.product, {
      new: true,
      runValidators: true,
      strict: 'throw'
    });
    if (!product) return res.status(404).json({ error: 'Product not found.' });
    res.json(product);
  } catch (err) {
    console.error('Error updating admin product:', err.message);
    res.status(err.name === 'ValidationError' ? 400 : 500).json({
      error: err.name === 'ValidationError' ? 'Product details are invalid.' : 'Product could not be updated.'
    });
  }
});

app.delete('/api/admin/products/:id', verifyAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Product ID is invalid.' });
  try {
    await connectDB();
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found.' });
    res.json({ message: 'Product deleted successfully.' });
  } catch (err) {
    console.error('Error deleting admin product:', err.message);
    res.status(500).json({ error: 'Product could not be deleted.' });
  }
});

app.post('/api/reviews', async (req, res) => {
  try {
    const { customerName, rating, message, photo = '' } = req.body || {};
    if (typeof customerName !== 'string' || customerName.trim().length < 2 || customerName.trim().length > 50
      || !Number.isInteger(rating) || rating < 1 || rating > 5
      || typeof message !== 'string' || message.trim().length < 8 || message.trim().length > 800
      || typeof photo !== 'string' || photo.length > 300000
      || (photo && !/^data:image\/webp;base64,[A-Za-z0-9+/]+=*$/.test(photo))) {
      return res.status(400).json({ error: 'Check the review fields and use a WebP photo under 220 KB.' });
    }
    await connectDB();
    await Review.create({
      customerName: customerName.trim(),
      rating,
      message: message.trim(),
      photo
    });
    res.status(201).json({ message: 'Thanks! Your review will appear after it has been approved.' });
  } catch (err) {
    console.error('Error saving review:', err.message);
    res.status(500).json({ error: 'We could not submit your review. Please try again.' });
  }
});

app.get('/api/admin/orders', verifyAdmin, async (req, res) => {
  try {
    await connectDB();
    const orders = await Order.find({}).sort({ createdAt: -1 }).limit(100);
    res.json(orders);
  } catch (err) {
    console.error('Error fetching admin orders:', err.message);
    res.status(500).json({ error: 'Orders could not be loaded.' });
  }
});

app.patch('/api/admin/orders/:id', verifyAdmin, async (req, res) => {
  const { status } = req.body || {};
  if (!['Printing', 'Packed', 'Shipped'].includes(status)) {
    return res.status(400).json({ error: 'Choose Printing, Packed, or Shipped.' });
  }
  try {
    await connectDB();
    const currentOrder = await Order.findOne({ orderId: req.params.id });
    if (!currentOrder) return res.status(404).json({ error: 'Order not found.' });
    if (currentOrder.paymentStatus === 'Pending' && status !== 'Printing') {
      return res.status(409).json({ error: 'A pending online payment cannot be packed or shipped.' });
    }
    currentOrder.status = status;
    const order = await currentOrder.save();
    res.json(order);
  } catch (err) {
    console.error('Error updating order status:', err.message);
    res.status(500).json({ error: 'Order status could not be updated.' });
  }
});

app.get('/api/admin/reviews', verifyAdmin, async (req, res) => {
  try {
    await connectDB();
    const reviews = await Review.find({}).sort({ createdAt: -1 }).limit(20);
    res.json(reviews);
  } catch (err) {
    console.error('Error fetching admin reviews:', err.message);
    res.status(500).json({ error: 'Reviews could not be loaded.' });
  }
});

app.patch('/api/admin/reviews/:id', verifyAdmin, async (req, res) => {
  if (typeof (req.body || {}).approved !== 'boolean') {
    return res.status(400).json({ error: 'Review approval must be true or false.' });
  }
  try {
    await connectDB();
    const review = await Review.findByIdAndUpdate(req.params.id, { approved: req.body.approved }, { new: true });
    if (!review) return res.status(404).json({ error: 'Review not found.' });
    res.json({ id: review.id, approved: review.approved });
  } catch (err) {
    console.error('Error updating review approval:', err.message);
    res.status(500).json({ error: 'Review approval could not be updated.' });
  }
});

// Explicit root route handler to serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large.' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body must contain valid JSON.' });
  }
  console.error('Unhandled request error:', err.message);
  res.status(500).json({ error: 'The request could not be completed.' });
});

// Start locally if run directly, or export for Vercel serverless deployment
if (require.main === module || process.env.VERCEL) {
  validateStartupConfig();
}
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running live on http://localhost:${PORT}`);
  });
}
module.exports = app;