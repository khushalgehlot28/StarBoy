const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'starboy_super_secret_key';

// Connect to MongoDB Atlas Cluster0
mongoose.connect(MONGO_URI)
  .then(() => console.log('Connected to MongoDB Atlas (Cluster0) successfully!'))
  .catch(err => console.error('MongoDB connection error:', err.message));

// Product Schema
const productSchema = new mongoose.Schema({
  title: { type: String, required: true },
  price: { type: Number, required: true },
  originalPrice: { type: Number },
  discount: { type: String },
  image: { type: String, required: true },
  badge: { type: String }
});

const Product = mongoose.model('Product', productSchema);

// Admin Authentication Route
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASS || 'starboy2026';

  if (username === adminUser && password === adminPass) {
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '1h' });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Invalid admin credentials' });
});

// Get All Products (Public) - with connection state check
app.get('/api/products', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(500).json({ error: 'Database not connected yet. Please wait a moment.' });
    }
    const products = await Product.find({});
    res.json(products);
  } catch (err) {
    console.error('Error fetching products:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Add Product (Protected/Admin)
app.post('/api/products', async (req, res) => {
  try {
    const newProduct = new Product(req.body);
    await newProduct.save();
    res.status(201).json(newProduct);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete Product (Protected/Admin)
app.delete('/api/products/:id', async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.json({ message: 'Product deleted successfully' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Start locally if run directly, or export for Vercel serverless deployment
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running live on http://localhost:${PORT}`);
  });
}

module.exports = app;