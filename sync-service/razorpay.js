/**
 * Razorpay — create payment links for invoices
 */
const axios = require('axios');

const rpAuth = {
  username: process.env.RAZORPAY_KEY_ID,
  password: process.env.RAZORPAY_KEY_SECRET,
};

/**
 * Create a Razorpay Payment Link.
 * @param {object} opts
 * @param {string} opts.invoiceNumber  e.g. "INV-001"
 * @param {string} opts.customerName   e.g. "Villa 83"
 * @param {string} opts.phone          E.164 e.g. "+919999000001"
 * @param {number} opts.amountInPaise  e.g. 150000 for ₹1500
 * @returns {{ id: string, short_url: string }}
 */
async function createPaymentLink({ invoiceNumber, customerName, phone, amountInPaise }) {
  const res = await axios.post(
    'https://api.razorpay.com/v1/payment_links',
    {
      amount: amountInPaise,
      currency: 'INR',
      accept_partial: false,
      description: `Payment for ${invoiceNumber} — The Good Papaya`,
      customer: {
        name:   customerName,
        contact: phone.replace('+', ''),  // Razorpay wants without +
      },
      notify: { sms: true, email: false },
      reminder_enable: true,
      notes: { invoice_number: invoiceNumber },
      callback_url:    'https://thegoodpapaya.com/pages/invoices?payment=success',
      callback_method: 'get',
    },
    { auth: rpAuth }
  );

  return { id: res.data.id, short_url: res.data.short_url };
}

module.exports = { createPaymentLink };
