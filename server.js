const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const path = require('path');

dotenv.config();

const app = express();
app.use(express.json());
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

// Product Schema
const productSchema = new mongoose.Schema({
  title: { type: String, required: true },
  price: { type: Number, required: true },
  originalPrice: { type: Number },
  discount: { type: String },
  image: { type: String, required: true },
  badge: { type: String }
});

const Product = mongoose.models.Product || mongoose.model('Product', productSchema);

// Admin Authentication Route
app.post('/api/admin/login', (req, res) => {
  if (!isAdminAuthConfigured()) {
    return res.status(503).json({ error: 'Admin authentication is not configured on the server.' });
  }

  const { username, password } = req.body;

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