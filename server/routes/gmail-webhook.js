module.exports = async (req, res) => {
  try {
    console.log('Gmail webhook received:', JSON.stringify(req.body));
    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(200).send('OK');
  }
};
