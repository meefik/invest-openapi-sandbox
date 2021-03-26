const axios = require('axios');
const fs = require('fs');

const TOKEN = process.env.SANDBOX_TOKEN;
const FIGI = process.argv[2];
const DATE = process.argv[3];
const INTERVAL = process.argv[4] || 'hour';

if (!FIGI || !DATE || !TOKEN) {
  console.log('Usage: candles.js <FIGI> <DATE> [INTERVAL]');
  process.exit(1);
}

const candles = [];

function fn(from) {
  const to = new Date(from);
  to.setDate(from.getDate() + 1);
  console.log(to.toJSON());
  return axios({
    method: 'get',
    url: `https://api-invest.tinkoff.ru/openapi/sandbox/market/candles?figi=${FIGI}&from=${from.toJSON()}&to=${to.toJSON()}&interval=${INTERVAL}`,
    headers: {
      Authorization: `Bearer ${TOKEN}`
    }
  }).then(function({ data }) {
    const arr = data.payload.candles || [];
    candles.push(...arr);
    from.setDate(from.getDate() + 1);
    if (to < new Date()) {
      return fn(from);
    }
  });
}

fn(new Date(DATE)).then(function() {
  fs.writeFile(`./data/candles/${FIGI}_${INTERVAL}.json`, JSON.stringify(candles), function() {});
});
