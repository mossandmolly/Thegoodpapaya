-- Dynamic QR codes are removed entirely (see dispatch-order/generate-invoice/
-- sync-invoices code changes in the same commit) — a closed dynamic QR could
-- still accept an in-flight UPI payment, which Razorpay then auto-refunds
-- with no signal back to us, leaving an order wrongly marked paid
-- ("payment made on closed qr code"). The Delivery panel now shows one
-- fixed static QR image instead, so there's nothing left for this sweep to
-- refresh — unschedule it rather than leave a 15-min cron hitting a now-
-- no-op mode forever.
select cron.unschedule('sync-invoices-qr-sweep');
