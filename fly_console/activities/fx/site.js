/**
 * FlyMart — a small multi-view shop used as the FX under-test page.
 * Plain DOM + JS routing (same surface a Vue app would expose after render).
 */
(function (global) {
  "use strict";

  const PRODUCTS = [
    {
      id: "banana",
      name: "Banana extract",
      price: 12,
      blurb: "Classic ORN DA1 stimulant. Bottled at the Nest.",
    },
    {
      id: "acv",
      name: "Apple cider vinegar",
      price: 8,
      blurb: "Food-odor staple for hungry Kenyon cells.",
    },
    {
      id: "geosmin",
      name: "Geosmin vial",
      price: 18,
      blurb: "Mold note. Handle with care — flies hate it.",
    },
  ];

  let state = {
    view: "home",
    cart: {}, // id -> qty
    lastOrder: null,
  };

  function cartCount() {
    return Object.values(state.cart).reduce((a, b) => a + b, 0);
  }

  function cartLines() {
    return Object.keys(state.cart)
      .map((id) => {
        const p = PRODUCTS.find((x) => x.id === id);
        if (!p) return null;
        return { ...p, qty: state.cart[id], line: p.price * state.cart[id] };
      })
      .filter(Boolean);
  }

  function cartTotal() {
    return cartLines().reduce((a, l) => a + l.line, 0);
  }

  function html() {
    return `
      <div class="fx-site" id="fxSite">
        <header class="fx-site-header">
          <div class="fx-site-brand">FlyMart</div>
          <nav class="fx-site-nav" aria-label="Primary">
            <button type="button" class="fx-nav-link" data-nav="home">Home</button>
            <button type="button" class="fx-nav-link" data-nav="catalog">Catalog</button>
            <button type="button" class="fx-nav-link" data-nav="cart">Cart</button>
            <button type="button" class="fx-nav-link" data-nav="account">Account</button>
          </nav>
          <div class="fx-site-cartpill" id="fxCartPill" aria-live="polite">0 in cart</div>
        </header>
        <main class="fx-site-main" id="fxSiteMain"></main>
      </div>`;
  }

  function viewHome() {
    return `
      <section class="fx-view">
        <h1>Welcome to FlyMart</h1>
        <p class="fx-lede">Odors, extracts, and courtship supplies for working flies.</p>
        <button type="button" class="fx-btn primary" data-nav="catalog">Browse catalog</button>
      </section>`;
  }

  function viewCatalog() {
    return `
      <section class="fx-view">
        <h1>Catalog</h1>
        <div class="fx-product-grid">
          ${PRODUCTS.map(
            (p) => `
            <article class="fx-product" data-product="${p.id}">
              <h2>${p.name}</h2>
              <p>${p.blurb}</p>
              <div class="fx-product-row">
                <span class="fx-price">$${p.price}</span>
                <button type="button" class="fx-btn" data-add="${p.id}">Add ${p.name} to cart</button>
              </div>
            </article>`
          ).join("")}
        </div>
      </section>`;
  }

  function viewCart() {
    const lines = cartLines();
    if (!lines.length) {
      return `
        <section class="fx-view">
          <h1>Cart</h1>
          <p class="fx-empty">Your cart is empty.</p>
          <button type="button" class="fx-btn" data-nav="catalog">Browse catalog</button>
        </section>`;
    }
    return `
      <section class="fx-view">
        <h1>Cart</h1>
        <ul class="fx-cart-list">
          ${lines
            .map(
              (l) => `
            <li>
              <span>${l.name} × ${l.qty}</span>
              <span>$${l.line}</span>
            </li>`
            )
            .join("")}
        </ul>
        <div class="fx-cart-total">Total <strong>$${cartTotal()}</strong></div>
        <button type="button" class="fx-btn primary" data-nav="checkout">Checkout</button>
      </section>`;
  }

  function viewCheckout() {
    return `
      <section class="fx-view">
        <h1>Checkout</h1>
        <form id="fxCheckoutForm" class="fx-checkout" autocomplete="off" novalidate>
          <div class="fx-field">
            <label for="fxEmail">Email</label>
            <input id="fxEmail" name="email" type="email" placeholder="you@nest.test"/>
          </div>
          <div class="fx-field">
            <label for="fxShip">Ship to</label>
            <input id="fxShip" name="ship" type="text" placeholder="Street address"/>
          </div>
          <div class="fx-field">
            <label for="fxPay">Payment</label>
            <select id="fxPay" name="payment">
              <option value="">Select payment</option>
              <option>Mushroom body points</option>
              <option>Camelot credit</option>
              <option>Pheromone IOU</option>
            </select>
          </div>
          <button type="submit" class="fx-btn primary" id="fxPlaceOrder">Place order</button>
        </form>
      </section>`;
  }

  function viewAccount() {
    return `
      <section class="fx-view">
        <h1>Account</h1>
        <p>Sign-in is stubbed for QA. Last order: ${
          state.lastOrder ? state.lastOrder.id : "none yet"
        }.</p>
      </section>`;
  }

  function viewConfirm() {
    const o = state.lastOrder;
    return `
      <section class="fx-view fx-confirm">
        <h1>Order confirmed</h1>
        <p>Thanks${o && o.email ? ", " + o.email : ""} — order <strong>${
          o ? o.id : ""
        }</strong> is locked in.</p>
        <p class="fx-confirm-total">Charged $${o ? o.total : 0} via ${
          o ? o.payment : "—"
        }.</p>
        <button type="button" class="fx-btn" data-nav="catalog">Back to catalog</button>
      </section>`;
  }

  function renderView() {
    const main = document.getElementById("fxSiteMain");
    const pill = document.getElementById("fxCartPill");
    if (!main) return;
    const map = {
      home: viewHome,
      catalog: viewCatalog,
      cart: viewCart,
      checkout: viewCheckout,
      account: viewAccount,
      confirm: viewConfirm,
    };
    main.innerHTML = (map[state.view] || viewHome)();
    if (pill) pill.textContent = cartCount() + " in cart";
    document.querySelectorAll(".fx-nav-link").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-nav") === state.view);
    });
  }

  function go(view) {
    state.view = view;
    renderView();
  }

  function addToCart(id) {
    state.cart[id] = (state.cart[id] || 0) + 1;
    renderView();
  }

  function reset() {
    state = { view: "home", cart: {}, lastOrder: null };
    renderView();
  }

  function wire(root) {
    if (!root || root.dataset.fxSiteBound === "1") return;
    root.dataset.fxSiteBound = "1";
    root.addEventListener("click", (e) => {
      const nav = e.target.closest("[data-nav]");
      if (nav && root.contains(nav)) {
        e.preventDefault();
        go(nav.getAttribute("data-nav"));
        return;
      }
      const add = e.target.closest("[data-add]");
      if (add && root.contains(add)) {
        e.preventDefault();
        addToCart(add.getAttribute("data-add"));
      }
    });
    root.addEventListener("submit", (e) => {
      if (e.target.id !== "fxCheckoutForm") return;
      e.preventDefault();
      const email = (document.getElementById("fxEmail") || {}).value || "";
      const ship = (document.getElementById("fxShip") || {}).value || "";
      const pay = (document.getElementById("fxPay") || {}).value || "";
      state.lastOrder = {
        id: "FX-" + Math.floor(1000 + Math.random() * 9000),
        email: email.trim(),
        ship: ship.trim(),
        payment: pay,
        total: cartTotal(),
        lines: cartLines(),
      };
      state.cart = {};
      go("confirm");
    });
  }

  function mount(host) {
    host.innerHTML = html();
    const site = document.getElementById("fxSite");
    wire(site);
    reset();
    return site;
  }

  global.FxSite = {
    mount,
    reset,
    go,
    renderView,
    getState: () => state,
    PRODUCTS,
  };
})(window);
