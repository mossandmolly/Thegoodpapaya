exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { batches, system, model, max_tokens } = JSON.parse(event.body);
    const KEY = process.env.ANTHROPIC_API_KEY;

    const results = await Promise.all(batches.map(async (batch) => {
      const start = Date.now();
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens, system, messages: [{ role: 'user', content: [...batch, { type: 'text', text: 'Parse all orders. Return only valid compact JSON.' }] }] })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(JSON.stringify(data.error));
      return {
        text: data.content?.map(x => x.text || '').join('') || '',
        usage: data.usage,
        ms: Date.now() - start
      };
    }));

    return { statusCode: 200, headers, body: JSON.stringify(results) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
