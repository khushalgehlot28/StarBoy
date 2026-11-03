const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 160 },
  category: { type: String, required: true, trim: true, maxlength: 80, index: true },
  price: { type: Number, required: true, min: 0 },
  originalPrice: { type: Number, min: 0, default: null },
  discount: { type: String, trim: true, maxlength: 40, default: '' },
  badge: { type: String, trim: true, maxlength: 40, default: '' },
  image: { type: String, required: true, trim: true, maxlength: 2048 },
  inStock: { type: Boolean, default: true }
}, { timestamps: true, strict: true });

module.exports = mongoose.models.Product || mongoose.model('Product', productSchema);