const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');
const Product = require('./models/Product');
const Order = require('./models/Order');
const Review = require('./models/Review');

dotenv.config();

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors());

// Serve static files correctly using absolute paths for Vercel
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;

function isAdminAuthConfigured() {
  return Boolean(ADMIN_USER && ADMIN_PASS && JWT_SECRET && Buffer.byteLength(JWT_SECRET, 'utf8') >= 32);
}

// Robust Serverless MongoDB Connection Handler with IPv4 and Timeout fixes
async function connectDB() {
  if (mongoose.connection.readyState >= 1) {
    return;
  }
  if (!MONGO_URI) {
    throw new Error('MONGO_URI is not defined in environment variables.');
  }
  await mongoose.connect(MONGO_URI, {
    bufferCommands: false,
    family: 4,               // Forces IPv4 to prevent ECONNRESET on serverless networks
    serverSelectionTimeoutMS: 5000 // Fails fast if connection times out instead of hanging
  });
}

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

// Admin Authentication Route
app.post('/api/admin/login', (req, res) => {
  if (!isAdminAuthConfigured()) {
    return res.status(503).json({ error: 'Admin authentication is not configured on the server.' });
  }

  const { username, password } = req.body || {};

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = jwt.sign({ username: ADMIN_USER }, JWT_SECRET, {
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
    if (err || !user || user.username !== ADMIN_USER) {
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
    const title = `${product.title} | Starboy Crafted`;
    const description = `Explore ${product.title} from Starboy Crafted, priced at ₹${product.price}.`;
    res.type('html').send(`<!DOCTYPE html>
      <html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
      <title>${escapeHtml(title)}</title>
      <meta name="description" content="${escapeHtml(description)}">
      <meta property="og:type" content="product"><meta property="og:title" content="${escapeHtml(title)}">
      <meta property="og:description" content="${escapeHtml(description)}">
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

app.post('/api/orders', async (req, res) => {
  try {
    const { customerName, phone, address, pincode, items } = req.body || {};
    if (typeof customerName !== 'string' || customerName.trim().length < 2 || customerName.length > 100
      || typeof phone !== 'string' || !/^[+\d\s()-]{8,20}$/.test(phone)
      || typeof address !== 'string' || address.trim().length < 5 || address.length > 500
      || typeof pincode !== 'string' || !/^\d{6}$/.test(pincode)
      || !Array.isArray(items) || !items.length || items.length > 30) {
      return res.status(400).json({ error: 'Enter valid customer and delivery details and at least one cart item.' });
    }
    const delivery = getPincodeServiceability(pincode);
    if (delivery.error) return res.status(503).json({ error: delivery.error });
    if (delivery.configured && !delivery.serviceable) {
      return res.status(400).json({ error: 'Delivery is not currently available for this PIN code.' });
    }

    await connectDB();
    const quantitiesById = new Map();
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)
        || !mongoose.isValidObjectId(item.productId)
        || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20
        || !['A4', 'A3'].includes(item.size)
        || !['Unframed', 'Framed'].includes(item.frame)) {
        return res.status(400).json({ error: 'One or more cart items are invalid. Please refresh your cart and try again.' });
      }
      const productId = String(item.productId).toLowerCase();
      quantitiesById.set(productId, (quantitiesById.get(productId) || 0) + item.quantity);
    }

    const products = await Product.find({ _id: { $in: [...quantitiesById.keys()] }, inStock: { $ne: false } });
    if (products.length !== quantitiesById.size) {
      return res.status(400).json({ error: 'One or more products are unavailable. Please refresh your cart.' });
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
    const total = orderItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const order = await Order.create({
      orderId: `SB-${crypto.randomBytes(10).toString('hex').toUpperCase()}`,
      customerName: customerName.trim(),
      phone: phone.trim(),
      address: address.trim(),
      pincode,
      items: orderItems,
      total
    });
    res.status(201).json({ orderId: order.orderId, total: order.total, status: order.status });
  } catch (err) {
    console.error('Error creating order:', err.message);
    res.status(500).json({ error: 'We could not save your order request. Please try WhatsApp again.' });
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
    const order = await Order.findOneAndUpdate({ orderId: req.params.id }, { status }, { new: true });
    if (!order) return res.status(404).json({ error: 'Order not found.' });
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

// Add Product (Protected/Admin)
app.post('/api/products', verifyAdmin, async (req, res) => {
  try {
    await connectDB();
    const newProduct = new Product(req.body);
    await newProduct.save();
    res.status(201).json(newProduct);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete Product (Protected/Admin)
app.delete('/api/products/:id', verifyAdmin, async (req, res) => {
  try {
    await connectDB();
    await Product.findByIdAndDelete(req.params.id);
    res.json({ message: 'Product deleted successfully' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Explicit root route handler to serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start locally if run directly, or export for Vercel serverless deployment
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running live on http://localhost:${PORT}`);
  });
}
module.exports = app;