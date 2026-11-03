const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  title: { type: String, required: true, trim: true, maxlength: 160 },
  image: { type: String, required: true, trim: true, maxlength: 2048 },
  price: { type: Number, required: true, min: 0 },
  quantity: { type: Number, required: true, min: 1, max: 20 },
  size: { type: String, required: true, enum: ['A4', 'A3'] },
  frame: { type: String, required: true, enum: ['Unframed', 'Framed'] }
}, { _id: false, strict: true });

const orderSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true, index: true, match: /^SB-[A-F0-9]{20}$/ },
  customerName: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
  phone: { type: String, required: true, trim: true, maxlength: 20, match: /^[+\d\s()-]{8,20}$/ },
  address: { type: String, required: true, trim: true, minlength: 5, maxlength: 500 },
  pincode: { type: String, required: true, match: /^\d{6}$/ },
  items: {
    type: [orderItemSchema],
    required: true,
    validate: { validator: items => items.length > 0, message: 'An order must have at least one item.' }
  },
  total: { type: Number, required: true, min: 0 },
  status: {
    type: String,
    enum: ['Printing', 'Packed', 'Shipped'],
    default: 'Printing'
  },
  paymentStatus: {
    type: String,
    enum: ['Not required', 'Pending', 'Paid'],
    default: 'Not required'
  },
  razorpayOrderId: { type: String, trim: true, sparse: true, unique: true },
  razorpayPaymentId: { type: String, trim: true, sparse: true, unique: true }
}, { timestamps: true, strict: true });

module.exports = mongoose.models.Order || mongoose.model('Order', orderSchema);
