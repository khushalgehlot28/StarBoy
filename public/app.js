let allProducts = [];
let cart = loadCart();

function loadCart() {
  try {
    const savedCart = JSON.parse(localStorage.getItem('starboy_cart') || '[]');
    return Array.isArray(savedCart) ? savedCart.filter(item =>
      item && typeof item._id === 'string' && Number.isInteger(item.quantity) && item.quantity > 0
    ).map(item => ({ ...item, price: Number(item.price) || 0 })) : [];
  } catch (error) {
    console.error('Could not restore the saved cart:', error);
    return [];
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initializeStorefrontEnhancements();
  fetchProducts();
  updateCartUI();

  const contactForm = document.getElementById('contactMessageForm');
  if (contactForm) {
    contactForm.addEventListener('submit', event => {
      event.preventDefault();
      const formData = new FormData(contactForm);
      const message = [
        `Name: ${formData.get('name')}`,
        `Contact: ${formData.get('contact')}`,
        `Message: ${formData.get('message')}`
      ].join('\n');
      const whatsappUrl = `https://wa.me/919521226338?text=${encodeURIComponent(message)}`;
      window.open(whatsappUrl, '_blank', 'noopener,noreferrer');
      document.getElementById('contactFormStatus').textContent = 'WhatsApp opened with your message. Send it there to reach us.';
    });
  }

  const productGrid = document.getElementById('productGrid');
  const searchInput = document.getElementById('productSearch');
  const searchForm = document.getElementById('productSearchForm');
  const searchTerm = new URLSearchParams(window.location.search).get('q');

  if (searchInput && searchTerm) searchInput.value = searchTerm;
  if (searchForm && productGrid) {
    searchForm.addEventListener('submit', event => {
      event.preventDefault();
      renderProducts();
    });
  }
  if (searchInput && productGrid) searchInput.addEventListener('input', renderProducts);

  ['categoryFilter', 'sortProducts', 'inStockFilter'].forEach(id => {
    const control = document.getElementById(id);
    if (control) control.addEventListener('change', renderProducts);
  });

  const clearFilters = document.getElementById('clearFilters');
  if (clearFilters) clearFilters.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    const categoryFilter = document.getElementById('categoryFilter');
    const sortProducts = document.getElementById('sortProducts');
    const inStockFilter = document.getElementById('inStockFilter');
    if (categoryFilter) categoryFilter.value = '';
    if (sortProducts) sortProducts.value = 'recommended';
    if (inStockFilter) inStockFilter.checked = false;
    renderProducts();
  });

  document.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const previewButton = target.closest('[data-view-product]');
    if (previewButton) {
      openQuickView(previewButton.dataset.viewProduct);
      return;
    }
    const addButton = target.closest('[data-add-item]');
    if (addButton) {
      const modal = addButton.closest('#quickViewModal');
      const size = modal?.querySelector('[name="productSize"]')?.value || 'A4';
      const frame = modal?.querySelector('[name="productFrame"]')?.value || 'Unframed';
      addToCart(addButton.dataset.addItem, { size, frame });
      return;
    }
    const cartButton = target.closest('[data-cart-key]');
    if (cartButton) changeQuantity(cartButton.dataset.cartKey, Number(cartButton.dataset.delta));
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeCartDrawer();
  });
  document.addEventListener('error', event => {
    const image = event.target;
    if (image instanceof HTMLImageElement && image.dataset.fallbackSrc) {
      image.src = image.dataset.fallbackSrc;
      delete image.dataset.fallbackSrc;
    }
  }, true);
});

async function fetchProducts() {
  try {
    const res = await fetch('/api/products');
    if (!res.ok) throw new Error(`Product request failed with status ${res.status}`);
    const data = await res.json();
    
    allProducts = Array.isArray(data) ? data : [];
    populateCategoryFilter();
    renderProducts();
    renderHomeSections();
    const sharedProductId = new URLSearchParams(window.location.search).get('product');
    if (sharedProductId) openQuickView(sharedProductId);
  } catch (err) {
    console.error('Error loading storefront products:', err);
    const grid = document.getElementById('productGrid');
    if (grid) {
      grid.innerHTML = '<p style="color:var(--accent); grid-column: 1/-1; text-align:center;">Failed to connect to backend server. Make sure npm start is running.</p>';
    }
    ['suggestedProductGrid', 'bestsellerProductGrid'].forEach(id => {
      const homeGrid = document.getElementById(id);
      if (homeGrid) {
        homeGrid.innerHTML = '<p class="catalog-message">Products could not be loaded. Please try again later.</p>';
      }
    });
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function optimizedImagePath(imagePath) {
  const path = String(imagePath || '');
  if (/^\/?assets\/images\/(?:[1-9]|1\d|20|project1)\.jpe?g$/i.test(path)) {
    return path.replace(/\.jpe?g$/i, '.webp');
  }
  return path;
}

function populateCategoryFilter() {
  const categoryFilter = document.getElementById('categoryFilter');
  if (!categoryFilter) return;
  const categories = [...new Set(allProducts.map(product => product.category).filter(Boolean))]
    .sort((first, second) => first.localeCompare(second));

  categoryFilter.innerHTML = '<option value="">All categories</option>';
  categories.forEach(category => {
    const option = document.createElement('option');
    option.value = category;
    option.textContent = category;
    categoryFilter.append(option);
  });
}

function renderProducts() {
  const grid = document.getElementById('productGrid');
  if (!grid) return;

  if (allProducts.length === 0) {
    grid.innerHTML = '<p class="catalog-message">No products available yet. Check back soon.</p>';
    return;
  }

  const searchTerm = (document.getElementById('productSearch')?.value || '').trim().toLowerCase();
  const selectedCategory = (document.getElementById('categoryFilter')?.value || '').toLowerCase();
  const inStockOnly = Boolean(document.getElementById('inStockFilter')?.checked);
  const sortBy = document.getElementById('sortProducts')?.value || 'recommended';
  const filteredProducts = allProducts.filter(product => {
    const category = String(product.category || '').toLowerCase();
    const title = String(product.title || '').toLowerCase();
    return (!searchTerm || title.includes(searchTerm) || category.includes(searchTerm))
      && (!selectedCategory || category === selectedCategory)
      && (!inStockOnly || product.inStock !== false);
  });

  if (sortBy === 'price-low') filteredProducts.sort((a, b) => a.price - b.price);
  if (sortBy === 'price-high') filteredProducts.sort((a, b) => b.price - a.price);
  if (sortBy === 'name') filteredProducts.sort((a, b) => a.title.localeCompare(b.title));
  if (sortBy === 'bestsellers') filteredProducts.sort((a, b) =>
    Number(/best[\s-]?seller/i.test(b.badge || '')) - Number(/best[\s-]?seller/i.test(a.badge || ''))
  );
  if (sortBy === 'newest') filteredProducts.sort((a, b) =>
    new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
  );

  if (filteredProducts.length === 0) {
    grid.innerHTML = '<p class="catalog-message">No products match these filters. Try changing your search or filters.</p>';
    return;
  }

  grid.innerHTML = filteredProducts.map(product => renderProductCard(product)).join('');
}

function renderHomeSections() {
  const suggestedGrid = document.getElementById('suggestedProductGrid');
  const bestsellerGrid = document.getElementById('bestsellerProductGrid');
  if (!suggestedGrid && !bestsellerGrid) return;

  const availableProducts = allProducts.filter(product => product.inStock !== false);
  const shuffledProducts = [...availableProducts];
  for (let index = shuffledProducts.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [shuffledProducts[index], shuffledProducts[randomIndex]] = [shuffledProducts[randomIndex], shuffledProducts[index]];
  }

  if (suggestedGrid) {
    const suggestions = shuffledProducts.slice(0, 4);
    suggestedGrid.innerHTML = suggestions.length
      ? suggestions.map(product => renderProductCard(product)).join('')
      : '<p class="catalog-message">No products available yet. Check back soon.</p>';
  }

  if (bestsellerGrid) {
    const bestsellers = availableProducts.filter(product => /best[\s-]?seller/i.test(product.badge || ''));
    bestsellerGrid.innerHTML = bestsellers.length
      ? bestsellers.slice(0, 4).map(product => renderProductCard(product)).join('')
      : '<p class="catalog-message">Our best sellers are coming soon. Check back for customer favorites.</p>';
  }
}

function renderProductCard(product) {
  const webpImage = optimizedImagePath(product.image);
  return `
    <article class="product-card">
      <button class="product-preview-trigger" type="button" data-view-product="${escapeHtml(product._id)}" aria-label="Quick view ${escapeHtml(product.title)}">
      <div class="product-img">
        ${product.badge ? `<span class="badge-bestseller">${escapeHtml(product.badge)}</span>` : ''}
        <picture>
          ${webpImage !== product.image ? `<source srcset="${escapeHtml(webpImage)}" type="image/webp">` : ''}
          <img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.title)}" loading="lazy" decoding="async">
        </picture>
      </div>
      </button>
      <div class="product-content">
        <h3 class="product-title">${escapeHtml(product.title)}</h3>
        <p class="product-category">${escapeHtml(product.category)}</p>
        <div class="price-row">
          <span class="price-current">₹${escapeHtml(product.price)}</span>
          ${product.originalPrice ? `<span class="price-original">₹${escapeHtml(product.originalPrice)}</span>` : ''}
          ${product.discount ? `<span class="discount">${escapeHtml(product.discount)}</span>` : ''}
        </div>
        <div class="product-card-actions">
          <button class="btn-quick-view" type="button" data-view-product="${escapeHtml(product._id)}">Quick view</button>
          <button class="btn-add-cart" type="button" data-add-item="${escapeHtml(product._id)}">Add to Cart</button>
        </div>
      </div>
    </article>
  `;
}

function initializeStorefrontEnhancements() {
  closeCartDrawer();
  const quickView = document.createElement('dialog');
  quickView.id = 'quickViewModal';
  quickView.className = 'store-modal';
  quickView.setAttribute('aria-labelledby', 'quickViewTitle');
  quickView.innerHTML = `
    <button class="modal-close" type="button" data-close-modal aria-label="Close preview">×</button>
    <div id="quickViewContent"></div>
  `;
  document.body.append(quickView);

  const checkout = document.createElement('dialog');
  checkout.id = 'checkoutModal';
  checkout.className = 'store-modal checkout-modal';
  checkout.setAttribute('aria-labelledby', 'checkoutTitle');
  checkout.innerHTML = `
    <button class="modal-close" type="button" data-close-modal aria-label="Close checkout">×</button>
    <h2 id="checkoutTitle">Your delivery details</h2>
    <p class="modal-note">This creates an order request and opens WhatsApp so you can confirm it with us.</p>
    <form id="checkoutForm" class="store-form">
      <label>Name<input name="customerName" autocomplete="name" required minlength="2" maxlength="100"></label>
      <label>Phone<input name="phone" type="tel" autocomplete="tel" required minlength="8" maxlength="20"></label>
      <label>Delivery address<textarea name="address" autocomplete="street-address" required minlength="5" maxlength="500" rows="3"></textarea></label>
      <label>PIN code<input name="pincode" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required></label>
      <button class="btn-quick-view" type="button" data-check-pin>Check delivery & COD</button>
      <p class="pin-status" data-pin-status role="status" aria-live="polite"></p>
      <button class="btn-add-cart" type="submit">Continue via WhatsApp</button>
      <p class="checkout-result" role="status" aria-live="polite"></p>
    </form>
  `;
  document.body.append(checkout);

  document.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const closeButton = target.closest('[data-close-modal]');
    if (closeButton) closeButton.closest('dialog')?.close();
    const pinButton = target.closest('[data-check-pin]');
    if (pinButton) {
      const pinScope = pinButton.closest('form') || pinButton.closest('.quick-view-details');
      const pincode = pinScope?.querySelector('[name="pincode"], [name="quickViewPincode"]')?.value || '';
      checkPincode(pincode, pinScope?.querySelector('[data-pin-status]'));
    }
  });

  const checkoutForm = document.getElementById('checkoutForm');
  checkoutForm.addEventListener('submit', submitOrderRequest);

  if (/\/(index|products)\.html$/.test(window.location.pathname) || window.location.pathname === '/') {
    addReviewsSection();
    loadReviews();
  }
}

function openQuickView(productId) {
  const product = allProducts.find(item => item._id === productId);
  const modal = document.getElementById('quickViewModal');
  const content = document.getElementById('quickViewContent');
  if (!product || !modal || !content) return;

  const dimensions = { A4: '21 × 29.7 cm', A3: '29.7 × 42 cm' };
  content.innerHTML = `
    <div class="quick-view-layout">
      <img class="quick-view-image" src="${escapeHtml(optimizedImagePath(product.image))}" alt="${escapeHtml(product.title)}" loading="eager" decoding="async">
      <div class="quick-view-details">
        <p class="eyebrow">${escapeHtml(product.category || 'Poster')}</p>
        <h2 id="quickViewTitle">${escapeHtml(product.title)}</h2>
        <p class="quick-view-price">₹${escapeHtml(product.price)}</p>
        <p class="modal-note">Preview the artwork up close. Pinch or use your browser zoom for image details.</p>
        <label>Size
          <select name="productSize">
            <option value="A4">A4 · ${dimensions.A4}</option>
            <option value="A3">A3 · ${dimensions.A3}</option>
          </select>
        </label>
        <label>Finish
          <select name="productFrame">
            <option value="Unframed">Unframed</option>
            <option value="Framed">Framed</option>
          </select>
        </label>
        <p class="modal-note">Framing and size pricing is confirmed with your order on WhatsApp.</p>
        <a class="share-product-link" href="/share/${encodeURIComponent(product._id)}" target="_blank" rel="noopener noreferrer">Share this poster</a>
        <label class="pin-label">Check delivery & COD
          <span class="pin-input-row">
            <input name="quickViewPincode" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="6-digit PIN code">
            <button type="button" class="btn-quick-view" data-check-pin>Check</button>
          </span>
        </label>
        <p class="pin-status" data-pin-status role="status" aria-live="polite"></p>
        <button class="btn-add-cart" type="button" data-add-item="${escapeHtml(product._id)}">Add to Cart · ₹${escapeHtml(product.price)}</button>
      </div>
    </div>
  `;
  modal.showModal();
}

async function checkPincode(pincode, statusElement) {
  if (!statusElement) return;
  const value = String(pincode).trim();
  if (!/^\d{6}$/.test(value)) {
    statusElement.textContent = 'Enter a valid 6-digit PIN code.';
    statusElement.classList.add('is-error');
    return;
  }
  statusElement.textContent = 'Checking delivery options…';
  statusElement.classList.remove('is-error');
  try {
    const response = await fetch('/api/serviceability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pincode: value })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not check this PIN code.');
    if (!result.configured) {
      statusElement.textContent = `${result.message} PIN: ${value}`;
    } else if (!result.serviceable) {
      statusElement.textContent = 'Delivery is not currently available for this PIN code.';
    } else {
      const estimate = result.estimateDays ? ` Estimated delivery: ${result.estimateDays} days.` : '';
      statusElement.textContent = `Delivery is available${result.codAvailable ? ' · COD available.' : ' · COD unavailable.'}${estimate}`;
    }
  } catch (error) {
    statusElement.textContent = error.message || 'Could not check this PIN code. Please contact us.';
    statusElement.classList.add('is-error');
  }
}

async function submitOrderRequest(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const resultElement = form.querySelector('.checkout-result');
  const submitButton = form.querySelector('[type="submit"]');
  const formData = new FormData(form);
  const waWindow = window.open('about:blank', '_blank');
  submitButton.disabled = true;
  resultElement.textContent = 'Saving your order request…';

  try {
    const pinResponse = await fetch('/api/serviceability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pincode: formData.get('pincode') })
    });
    const pinResult = await pinResponse.json();
    if (!pinResponse.ok) throw new Error(pinResult.error || 'PIN code check failed.');
    if (pinResult.configured && !pinResult.serviceable) {
      throw new Error('Delivery is not currently available for this PIN code.');
    }

    const response = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: formData.get('customerName'),
        phone: formData.get('phone'),
        address: formData.get('address'),
        pincode: formData.get('pincode'),
        items: cart.map(item => ({
          productId: item._id,
          quantity: item.quantity,
          size: item.size || 'A4',
          frame: item.frame || 'Unframed'
        }))
      })
    });
    const order = await response.json();
    if (!response.ok) throw new Error(order.error || 'Could not create the order request.');
    const lines = cart.map(item =>
      `- ${item.title} (${item.size || 'A4'}, ${item.frame || 'Unframed'}) × ${item.quantity}: ₹${item.price * item.quantity}`
    );
    const message = [
      `Hello Starboy Crafted, I would like to confirm order ${order.orderId}.`,
      `Name: ${formData.get('customerName')}`,
      `Phone: ${formData.get('phone')}`,
      `Address: ${formData.get('address')}, ${formData.get('pincode')}`,
      'Items:',
      ...lines,
      `Listed-price subtotal: ₹${order.total} (final size and frame pricing to be confirmed)`
    ].join('\n');
    const whatsappUrl = `https://wa.me/919521226338?text=${encodeURIComponent(message)}`;
    resultElement.innerHTML = `Order request saved. Your tracking ID is <strong>${escapeHtml(order.orderId)}</strong>. `;
    const whatsappLink = document.createElement('a');
    whatsappLink.href = whatsappUrl;
    whatsappLink.target = '_blank';
    whatsappLink.rel = 'noopener noreferrer';
    whatsappLink.textContent = 'Open WhatsApp to confirm';
    resultElement.append(whatsappLink);
    if (waWindow && !waWindow.closed) {
      waWindow.location.href = whatsappUrl;
    } else {
      window.open(whatsappUrl, '_blank', 'noopener,noreferrer');
    }
    cart = [];
    saveAndRefreshCart();
  } catch (error) {
    if (waWindow && !waWindow.closed) waWindow.close();
    resultElement.textContent = error.message || 'Could not place your order request. Please try again.';
  } finally {
    submitButton.disabled = false;
  }
}

function addReviewsSection() {
  const main = document.querySelector('main');
  if (!main) return;
  const section = document.createElement('section');
  section.className = 'catalog-section customer-reviews';
  section.setAttribute('aria-labelledby', 'reviewsHeading');
  section.innerHTML = `
    <div class="catalog-heading">
      <div><p class="eyebrow">From our community</p><h2 id="reviewsHeading">Customer reviews</h2></div>
      <p class="review-average" id="reviewAverage"></p>
    </div>
    <div class="review-layout">
      <div class="review-list" id="reviewList" aria-live="polite"><p class="catalog-message">Loading reviews…</p></div>
      <form class="review-form store-form" id="reviewForm">
        <h3>Share your wall</h3>
        <label>Your name<input name="customerName" required minlength="2" maxlength="50" autocomplete="name"></label>
        <label>Rating
          <select name="rating" required>
            <option value="5">★★★★★ · Loved it</option><option value="4">★★★★☆ · Great</option>
            <option value="3">★★★☆☆ · Good</option><option value="2">★★☆☆☆ · Fair</option><option value="1">★☆☆☆☆ · Poor</option>
          </select>
        </label>
        <label>Your review<textarea name="message" rows="4" required minlength="8" maxlength="800"></textarea></label>
        <label>Photo of your poster (optional)<input name="photo" type="file" accept="image/*"></label>
        <p class="modal-note">Reviews and photos are published after moderation. Images are resized before upload.</p>
        <button class="btn-add-cart" type="submit">Submit review</button>
        <p class="review-form-status" role="status" aria-live="polite"></p>
      </form>
    </div>
  `;
  main.append(section);
  section.querySelector('#reviewForm').addEventListener('submit', submitReview);
}

async function loadReviews() {
  const list = document.getElementById('reviewList');
  const average = document.getElementById('reviewAverage');
  if (!list || !average) return;
  try {
    const response = await fetch('/api/reviews');
    const reviews = await response.json();
    if (!response.ok) throw new Error(reviews.error || 'Reviews could not be loaded.');
    if (!reviews.length) {
      list.innerHTML = '<p class="catalog-message">No published reviews yet. Be the first to share yours.</p>';
      average.textContent = '';
      return;
    }
    const rating = reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length;
    average.textContent = `★ ${rating.toFixed(1)} / 5 · ${reviews.length} review${reviews.length === 1 ? '' : 's'}`;
    list.innerHTML = reviews.map(review => `
      <article class="review-card">
        <div class="review-card-heading"><strong>${escapeHtml(review.customerName)}</strong><span>${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)}</span></div>
        <p>${escapeHtml(review.message)}</p>
        ${review.photo ? `<img src="${escapeHtml(review.photo)}" alt="Customer poster display" loading="lazy">` : ''}
      </article>
    `).join('');
  } catch (error) {
    list.innerHTML = `<p class="catalog-message">${escapeHtml(error.message)}</p>`;
  }
}

async function resizeReviewPhoto(file) {
  if (!file || !file.name) return '';
  if (!file.type.startsWith('image/') || file.size > 5 * 1024 * 1024) {
    throw new Error('Choose an image file smaller than 5 MB.');
  }
  const image = new Image();
  const imageUrl = URL.createObjectURL(file);
  try {
    image.src = imageUrl;
    await image.decode();
    const scale = Math.min(1, 700 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/webp', 0.72);
    if (!dataUrl.startsWith('data:image/webp,')) {
      throw new Error('This browser cannot prepare WebP photos. Please submit without a photo.');
    }
    if (dataUrl.length > 300000) throw new Error('That photo is too large after compression. Try a smaller image.');
    return dataUrl;
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

async function submitReview(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = form.querySelector('.review-form-status');
  const submitButton = form.querySelector('[type="submit"]');
  const data = new FormData(form);
  submitButton.disabled = true;
  status.textContent = 'Submitting review…';
  try {
    const photo = await resizeReviewPhoto(data.get('photo'));
    const response = await fetch('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: data.get('customerName'),
        rating: Number(data.get('rating')),
        message: data.get('message'),
        photo
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Review could not be submitted.');
    status.textContent = result.message;
    form.reset();
  } catch (error) {
    status.textContent = error.message || 'Review could not be submitted.';
  } finally {
    submitButton.disabled = false;
  }
}

// Toggle Sliding Cart Drawer
function toggleCartDrawer(e) {
  if (e) e.preventDefault();
  const drawer = document.getElementById('cartDrawer');
  const overlay = document.getElementById('cartOverlay');
  if (!drawer || !overlay) return;
  
  if (drawer.classList.contains('is-open')) {
    closeCartDrawer();
  } else {
    drawer.inert = false;
    drawer.classList.add('is-open');
    overlay.classList.add('is-visible');
    drawer.setAttribute('aria-hidden', 'false');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('drawer-open');
  }
}

function closeCartDrawer() {
  const drawer = document.getElementById('cartDrawer');
  const overlay = document.getElementById('cartOverlay');
  if (!drawer || !overlay) return;
  drawer.classList.remove('is-open');
  overlay.classList.remove('is-visible');
  drawer.inert = true;
  drawer.setAttribute('aria-hidden', 'true');
  overlay.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('drawer-open');
}

// Add Product to Cart
function addToCart(productId, options = {}) {
  const product = allProducts.find(p => p._id === productId);
  if (!product) return;

  const size = options.size || 'A4';
  const frame = options.frame || 'Unframed';
  const cartKey = `${productId}:${size}:${frame}`;
  const existingItem = cart.find(item => item.cartKey === cartKey);
  if (existingItem) {
    existingItem.quantity += 1;
  } else {
    cart.push({ ...product, quantity: 1, size, frame, cartKey });
  }

  saveAndRefreshCart();
  toggleCartDrawer();
}

// Update Item Quantity
function changeQuantity(productId, delta) {
  const item = cart.find(item => (item.cartKey || item._id) === productId);
  if (!item) return;

  item.quantity += delta;
  if (item.quantity <= 0) {
    cart = cart.filter(p => p._id !== productId);
  }

  saveAndRefreshCart();
}

// Save to LocalStorage and Update View
function saveAndRefreshCart() {
  try {
    localStorage.setItem('starboy_cart', JSON.stringify(cart));
  } catch (error) {
    console.error('Could not save the cart:', error);
  }
  updateCartUI();
}

// Render Cart Drawer & Calculate Totals
function updateCartUI() {
  const container = document.getElementById('cartItemsContainer');
  const countBadge = document.getElementById('cartCount');
  const totalPriceEl = document.getElementById('cartTotalPrice');
  if (!container || !countBadge || !totalPriceEl) return;

  const totalItemsCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  countBadge.textContent = totalItemsCount;

  if (cart.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted); text-align: center; margin-top: 2rem;">Your cart is empty.</p>';
    totalPriceEl.textContent = '₹0';
    return;
  }

  container.innerHTML = '';
  let subtotal = 0;

  cart.forEach(item => {
    subtotal += item.price * item.quantity;
    container.innerHTML += `
      <div class="cart-item">
        <img src="${escapeHtml(optimizedImagePath(item.image))}" data-fallback-src="${escapeHtml(item.image)}" alt="${escapeHtml(item.title)}">
        <div class="cart-item-details">
          <h4>${escapeHtml(item.title)}</h4>
          <span class="cart-item-variant">${escapeHtml(item.size || 'A4')} · ${escapeHtml(item.frame || 'Unframed')}</span>
          <span class="cart-item-price">₹${escapeHtml(item.price)} × ${item.quantity}</span>
          <div class="cart-quantity">
            <button type="button" data-cart-key="${escapeHtml(item.cartKey || item._id)}" data-delta="-1" aria-label="Decrease quantity">−</button>
            <span>${item.quantity}</span>
            <button type="button" data-cart-key="${escapeHtml(item.cartKey || item._id)}" data-delta="1" aria-label="Increase quantity">+</button>
          </div>
        </div>
      </div>
    `;
  });

  totalPriceEl.textContent = `₹${subtotal}`;
}

function proceedToCheckout() {
  if (cart.length === 0) {
    alert('Your cart is empty!');
    return;
  }
  document.getElementById('checkoutModal')?.showModal();
}