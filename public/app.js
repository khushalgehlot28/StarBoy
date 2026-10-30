let allProducts = [];
let cart = JSON.parse(localStorage.getItem('starboy_cart')) || [];

document.addEventListener('DOMContentLoaded', () => {
  fetchProducts();
  updateCartUI();

  document.getElementById('productSearchForm').addEventListener('submit', event => {
    event.preventDefault();
    renderProducts();
  });
  document.getElementById('productSearch').addEventListener('input', renderProducts);
  document.getElementById('categoryFilter').addEventListener('change', renderProducts);
  document.getElementById('sortProducts').addEventListener('change', renderProducts);
  document.getElementById('inStockFilter').addEventListener('change', renderProducts);
  document.getElementById('clearFilters').addEventListener('click', () => {
    document.getElementById('productSearch').value = '';
    document.getElementById('categoryFilter').value = '';
    document.getElementById('sortProducts').value = 'recommended';
    document.getElementById('inStockFilter').checked = false;
    renderProducts();
  });
  document.getElementById('productGrid').addEventListener('click', event => {
    const button = event.target.closest('[data-product-id]');
    if (button) addToCart(button.dataset.productId);
  });
});

async function fetchProducts() {
  try {
    const res = await fetch('/api/products');
    if (!res.ok) throw new Error(`Product request failed with status ${res.status}`);
    const data = await res.json();
    
    allProducts = Array.isArray(data) ? data : [];
    populateCategoryFilter();
    renderProducts();
  } catch (err) {
    console.error('Error loading storefront products:', err);
    const grid = document.getElementById('productGrid');
    if (grid) {
      grid.innerHTML = '<p style="color:var(--accent); grid-column: 1/-1; text-align:center;">Failed to connect to backend server. Make sure npm start is running.</p>';
    }
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

function populateCategoryFilter() {
  const categoryFilter = document.getElementById('categoryFilter');
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

  const searchTerm = document.getElementById('productSearch').value.trim().toLowerCase();
  const selectedCategory = document.getElementById('categoryFilter').value.toLowerCase();
  const inStockOnly = document.getElementById('inStockFilter').checked;
  const sortBy = document.getElementById('sortProducts').value;
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

  if (filteredProducts.length === 0) {
    grid.innerHTML = '<p class="catalog-message">No products match these filters. Try changing your search or filters.</p>';
    return;
  }

  grid.innerHTML = filteredProducts.map(product => `
    <article class="product-card">
      <div class="product-img">
        ${product.badge ? `<span class="badge-bestseller">${escapeHtml(product.badge)}</span>` : ''}
        <img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.title)}" loading="lazy">
      </div>
      <div class="product-content">
        <h3 class="product-title">${escapeHtml(product.title)}</h3>
        <p class="product-category">${escapeHtml(product.category)}</p>
        <div class="price-row">
          <span class="price-current">₹${escapeHtml(product.price)}</span>
          ${product.originalPrice ? `<span class="price-original">₹${escapeHtml(product.originalPrice)}</span>` : ''}
          ${product.discount ? `<span class="discount">${escapeHtml(product.discount)}</span>` : ''}
        </div>
        <button class="btn-add-cart" type="button" data-product-id="${escapeHtml(product._id)}">Add to Cart</button>
      </div>
    </article>
  `).join('');
}

// Toggle Sliding Cart Drawer
function toggleCartDrawer(e) {
  if (e) e.preventDefault();
  const drawer = document.getElementById('cartDrawer');
  const overlay = document.getElementById('cartOverlay');
  
  if (drawer.style.right === '0px') {
    drawer.style.right = '-400px';
    overlay.style.display = 'none';
  } else {
    drawer.style.right = '0px';
    overlay.style.display = 'block';
  }
}

// Add Product to Cart
function addToCart(productId) {
  const product = allProducts.find(p => p._id === productId);
  if (!product) return;

  const existingItem = cart.find(item => item._id === productId);
  if (existingItem) {
    existingItem.quantity += 1;
  } else {
    cart.push({ ...product, quantity: 1 });
  }

  saveAndRefreshCart();
  toggleCartDrawer();
}

// Update Item Quantity
function changeQuantity(productId, delta) {
  const item = cart.find(item => item._id === productId);
  if (!item) return;

  item.quantity += delta;
  if (item.quantity <= 0) {
    cart = cart.filter(p => p._id !== productId);
  }

  saveAndRefreshCart();
}

// Save to LocalStorage and Update View
function saveAndRefreshCart() {
  localStorage.setItem('starboy_cart', JSON.stringify(cart));
  updateCartUI();
}

// Render Cart Drawer & Calculate Totals
function updateCartUI() {
  const container = document.getElementById('cartItemsContainer');
  const countBadge = document.getElementById('cartCount');
  const totalPriceEl = document.getElementById('cartTotalPrice');

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
      <div style="display: flex; gap: 1rem; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 0.75rem;">
        <img src="${item.image}" alt="${item.title}" style="width: 60px; height: 60px; object-fit: cover; border-radius: 6px;" onerror="this.src='https://via.placeholder.com/60?text=Img'">
        <div style="flex-grow: 1;">
          <h4 style="margin: 0; font-size: 0.9rem; font-family: var(--font-display);">${item.title}</h4>
          <span style="font-size: 0.85rem; color: var(--text-muted);">₹${item.price} x ${item.quantity}</span>
          <div style="display: flex; gap: 0.5rem; margin-top: 0.3rem;">
            <button onclick="changeQuantity('${item._id}', -1)" style="padding: 0.1rem 0.5rem; cursor: pointer;">-</button>
            <span style="font-size: 0.85rem; font-weight: 600;">${item.quantity}</span>
            <button onclick="changeQuantity('${item._id}', 1)" style="padding: 0.1rem 0.5rem; cursor: pointer;">+</button>
          </div>
        </div>
      </div>
    `;
  });

  totalPriceEl.textContent = `₹${subtotal}`;
}

// Proceed to Checkout stub
function proceedToCheckout() {
  if (cart.length === 0) {
    alert('Your cart is empty!');
    return;
  }
  alert('Proceeding to checkout...');
}