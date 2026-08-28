import { showToast } from './toast.js';
// Generates a simple, clean PDF invoice for a single order using jsPDF (loaded via CDN in orders.html)
export function generateInvoice(order, orderId) {
    if (!window.jspdf) {
        showToast("Invoice generator is still loading — please try again in a moment.", 'error');
        return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    const dateStr = order.createdAt && order.createdAt.toDate
        ? order.createdAt.toDate().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
        : new Date().toLocaleDateString('en-IN');

    // Header
    doc.setFillColor(35, 47, 62); // #232f3e
    doc.rect(0, 0, 210, 28, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(20);
    doc.setFont(undefined, 'bold');
    doc.text('DesiMarket', 14, 18);
    doc.setFontSize(10);
    doc.setFont(undefined, 'normal');
    doc.text('Order Invoice / Receipt', 14, 24);

    // Body
    doc.setTextColor(20, 20, 20);
    let y = 42;

    doc.setFontSize(12);
    doc.setFont(undefined, 'bold');
    doc.text('Order Details', 14, y);
    doc.setFont(undefined, 'normal');
    doc.setFontSize(10.5);
    y += 8;
    doc.text(`Order ID: ${orderId}`, 14, y); y += 6;
    doc.text(`Order Date: ${dateStr}`, 14, y); y += 6;
    doc.text(`Status: ${order.status || 'Pending'}`, 14, y); y += 6;
    doc.text(`Payment Method: ${order.paymentMethod || 'N/A'}`, 14, y); y += 12;

    doc.setFontSize(12);
    doc.setFont(undefined, 'bold');
    doc.text('Delivery Address', 14, y);
    doc.setFont(undefined, 'normal');
    doc.setFontSize(10.5);
    y += 8;
    doc.text(`${order.buyerName || 'N/A'}`, 14, y); y += 6;
    doc.text(`${order.buyerPhone || 'N/A'}`, 14, y); y += 6;
    const addressLines = doc.splitTextToSize(order.buyerAddress || 'N/A', 180);
    doc.text(addressLines, 14, y);
    y += addressLines.length * 6 + 10;

    // Item table header
    doc.setFillColor(240, 242, 242);
    doc.rect(14, y, 182, 9, 'F');
    doc.setFont(undefined, 'bold');
    doc.setFontSize(10.5);
    doc.text('Item', 17, y + 6);
    doc.text('Qty', 130, y + 6);
    doc.text('Amount', 165, y + 6);
    y += 9;

    doc.setFont(undefined, 'normal');
    doc.text(String(order.productName || 'Item'), 17, y + 7);
    doc.text(String(order.quantity || 1), 130, y + 7);
    doc.text(`Rs. ${order.price || 0}`, 165, y + 7);
    y += 14;

    doc.setDrawColor(220, 220, 220);
    doc.line(14, y, 196, y);
    y += 8;

    doc.setFont(undefined, 'bold');
    doc.setFontSize(12);
    doc.text('Total Paid', 130, y);
    doc.text(`Rs. ${order.price || 0}`, 165, y);
    y += 16;

    doc.setFont(undefined, 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(120, 120, 120);
    doc.text(`Sold by: ${order.shopName || 'DesiMarket Seller'}`, 14, y);
    y += 14;

    doc.setFontSize(9);
    doc.text('This is a system-generated invoice from DesiMarket. Vocal for Local.', 14, 285);

    doc.save(`DesiMarket_Invoice_${orderId}.pdf`);
}

