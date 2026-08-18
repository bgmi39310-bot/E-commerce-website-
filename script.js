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
        const originalIndex = products.findIndex(p => p.name === product.name);
        productGrid.innerHTML += `
            <div class="product-card">
                <img src="${product.image}" alt="${product.name}" onerror="this.src='https://via.placeholder.com/250?text=Invalid+Image'">
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
                    <img src="${item.image}" alt="${item.name}" onerror="this.src='https://via.placeholder.com/100?text=Image'">
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

// Toggle between Login and Signup mode
const toggleText = document.getElementById('toggleText');
const formTitle = document.getElementById('formTitle');
const nameField = document.getElementById('nameField');
const submitBtn = document.getElementById('submitBtn');
const authForm = document.getElementById('authForm');

let isSignup = false;

if (toggleText) {
    toggleText.addEventListener('click', () => {
        isSignup = !isSignup;
        if (isSignup) {
            formTitle.innerText = "Create a DesiMarket Account";
            nameField.style.display = "block";
            submitBtn.innerText = "Sign Up";
            toggleText.innerText = "Already have an account? Login";
        } else {
            formTitle.innerText = "Login to Your Account";
            nameField.style.display = "none";
            submitBtn.innerText = "Login";
            toggleText.innerText = "New to DesiMarket? Create an account";
        }
    });
}

// Handle Form Submission
if (authForm) {
    authForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;

        if (isSignup) {
            const fullName = document.getElementById('fullName').value;
            localStorage.setItem('userName', fullName);
            localStorage.setItem('userEmail', email);
            localStorage.setItem('userPassword', password);
            alert('Signup Successful! Please login now.');
            isSignup = false;
            formTitle.innerText = "Login to Your Account";
            nameField.style.display = "none";
            submitBtn.innerText = "Login";
            toggleText.innerText = "New to DesiMarket? Create an account";
            authForm.reset();
        } else {
            const savedEmail = localStorage.getItem('userEmail');
            const savedPassword = localStorage.getItem('userPassword');

            if (email === savedEmail && password === savedPassword) {
                alert('Login Successful! Welcome back.');
                window.location.href = 'index.html';
            } else {
                alert('Invalid email or password. Please sign up if you don\'t have an account.');
            }
        }
    });
}
