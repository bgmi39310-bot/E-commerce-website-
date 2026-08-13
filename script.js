// LocalStorage based E-Commerce Logic with Live Search

// Initialize default products if none exist
if (!localStorage.getItem('products')) {
    const defaultProducts = [
        { name: "Smart Watch", price: 1999, image: "https://via.placeholder.com/250", desc: "Feature-packed smart watch with fitness tracking." },
        { name: "Running Shoes", price: 2499, image: "https://via.placeholder.com/250", desc: "Comfortable and durable sports shoes." }
    ];
    localStorage.setItem('products', JSON.stringify(defaultProducts));
}

if (!localStorage.getItem('cart')) {
    localStorage.setItem('cart', JSON.stringify([]));
}

// Function to handle selling a new product
const sellForm = document.getElementById('sellForm');
if (sellForm) {
    sellForm.addEventListener('submit', function(e) {
        e.preventDefault();
        const name = document.getElementById('productName').value;
        const price = Number(document.getElementById('productPrice').value);
        const image = document.getElementById('productImage').value;
        const desc = document.getElementById('productDesc').value;

        const products = JSON.parse(localStorage.getItem('products'));
        products.push({ name, price, image, desc });
        localStorage.setItem('products', JSON.stringify(products));

        alert('Product published successfully!');
        window.location.href = 'index.html';
    });
}

// Function to display products on the homepage with search filter
function displayProducts(filterText = "") {
    const productGrid = document.getElementById('productGrid');
    if (!productGrid) return;

    const products = JSON.parse(localStorage.getItem('products'));
    productGrid.innerHTML = '';

    const filteredProducts = products.filter(product => 
        product.name.toLowerCase().includes(filterText.toLowerCase())
    );

    if (filteredProducts.length === 0) {
        productGrid.innerHTML = '<p>No products found.</p>';
        return;
    }

    filteredProducts.forEach((product, index) => {
        // Find original index for cart mapping
        const originalIndex = products.findIndex(p => p.name === product.name);
        productGrid.innerHTML += `
            <div class="product-card">
                <img src="${product.image}" alt="${product.name}">
                <h3>${product.name}</h3>
                <div class="price">₹${product.price}</div>
                <p style="font-size: 13px; color: #666;">${product.desc}</p>
                <button class="btn" onclick="addToCart(${originalIndex})">Add to Cart</button>
            </div>
        `;
    });
}

// Initial display on load
if (document.getElementById('productGrid')) {
    displayProducts();
}

// Live Search Event Listener
const searchInput = document.getElementById('searchInput');
if (searchInput) {
    searchInput.addEventListener('input', function(e) {
        displayProducts(e.target.value);
    });
}

// Function to add items to cart
window.addToCart = function(index) {
    const products = JSON.parse(localStorage.getItem('products'));
    const cart = JSON.parse(localStorage.getItem('cart'));
    cart.push(products[index]);
    localStorage.setItem('cart', JSON.stringify(cart));
    alert('Product added to cart!');
};

// Function to display cart items
const cartItemsContainer = document.getElementById('cartItemsContainer');
if (cartItemsContainer) {
    const cart = JSON.parse(localStorage.getItem('cart'));
    cartItemsContainer.innerHTML = '';
    let total = 0;

    if (cart.length === 0) {
        cartItemsContainer.innerHTML = '<p>Your cart is empty.</p>';
    } else {
        cart.forEach((item, index) => {
            total += item.price;
            cartItemsContainer.innerHTML += `
                <div class="cart-item">
                    <img src="${item.image}" alt="${item.name}">
                    <div class="item-details">
                        <div class="item-title">${item.name}</div>
                        <div class="item-price">₹${item.price}</div>
                    </div>
                    <button class="remove-btn" onclick="removeFromCart(${index})">Remove</button>
                </div>
            `;
        });
    }

    const totalElement = document.querySelector('.total-amount');
    if (totalElement) {
        totalElement.innerText = `Total: ₹${total}`;
    }
}

// Function to remove item from cart
window.removeFromCart = function(index) {
    const cart = JSON.parse(localStorage.getItem('cart'));
    cart.splice(index, 1);
    localStorage.setItem('cart', JSON.stringify(cart));
    location.reload();
};

