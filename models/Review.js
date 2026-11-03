const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  customerName: { type: String, required: true, maxlength: 50 },
  rating: { type: Number, required: true, min: 1, max: 5 },
  message: { type: String, required: true, maxlength: 800 },
  photo: { type: String, default: '' },
  approved: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.models.Review || mongoose.model('Review', reviewSchema);
