const nconf = require('nconf');
const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const bodyParser = require('body-parser');

const stocks = require('./data/stocks.json');
const bonds = require('./data/bonds.json');
const etfs = require('./data/etfs.json');
const currencies = require('./data/currencies.json');

nconf.env({
  separator: '_',
  lowerCase: true,
  parseValues: true
});
nconf.defaults({
  host: '0.0.0.0',
  port: 8080
});

let trackId = 0;
function getTrackId() {
  return String(++trackId);
}

let orderId = 0;
function getOrderId() {
  return String(++orderId);
}

function findInstrument(query) {
  const fn = item => {
    for (const k in query) {
      if (query[k] !== item[k]) return false;
    }
    return true;
  };
  let instrument = stocks.find(fn);
  if (instrument) return instrument;
  instrument = bonds.find(fn);
  if (instrument) return instrument;
  instrument = etfs.find(fn);
  if (instrument) return instrument;
  instrument = currencies.find(fn);
  if (instrument) return instrument;
}

function filterInstruments(query) {
  const fn = item => {
    for (const k in query) {
      if (query[k] !== item[k]) return false;
    }
    return true;
  };
  let instruments = stocks.filter(fn);
  if (instruments.length > 0) return instruments;
  instruments = bonds.filter(fn);
  if (instruments.length > 0) return instruments;
  instruments = etfs.filter(fn);
  if (instruments.length > 0) return instruments;
  instruments = currencies.filter(fn);
  if (instruments.length > 0) return instruments;
  return [];
}

const candles = {
  BBG000000000: JSON.parse(fs.readFileSync('./data/candles/BBG000000000_hour.json', 'utf8')),
  BBG000000001: JSON.parse(fs.readFileSync('./data/candles/BBG000000001_hour.json', 'utf8')),
  BBG000000002: JSON.parse(fs.readFileSync('./data/candles/BBG000000002_hour.json', 'utf8'))
};
const current = {};
const operations = [];
const positions = {};
const balance = {
  RUB: {
    currency: 'RUB',
    balance: 100000
  },
  USD: {
    currency: 'USD',
    balance: 10000
  },
  EUR: {
    currency: 'EUR',
    balance: 10000
  }
};

const app = express();
app.enable('trust proxy');
app.disable('x-powered-by');
app.use(bodyParser.json());

// https://tinkoffcreditsystems.github.io/invest-openapi/swagger-ui/

app.post('/sandbox/register', function(req, res) {
  res.json({
    trackingId: getTrackId(),
    status: 'Ok',
    payload: {
      brokerAccountType: 'Tinkoff',
      brokerAccountId: '1'
    }
  });
});

app.post('/sandbox/currencies/balance', function(req, res) {
  const { currency = 'RUB', balance = 100000 } = req.body;
  balance[currency] = { currency, balance };
  let figi;
  if (currency === 'USD') figi = 'BBG0013HGFT4';
  else if (currency === 'EUR') figi = 'BBG0013HJJ31';
  const instrument = findInstrument({ figi, type: 'Currency' });
  if (instrument) {
    const lots = ~~(balance / instrument.lot);
    positions[currency] = {
      figi: instrument.figi,
      name: instrument.name,
      ticker: instrument.ticker,
      isin: instrument.isin,
      instrumentType: instrument.type,
      balance: lots * instrument.lot,
      lots: lots
    };
  }
  res.json({
    trackingId: getTrackId(),
    status: 'Ok',
    payload: {}
  });
});

app.post('/sandbox/positions/balance', function(req, res) {
  const { figi, balance = 1 } = req.body;
  const instrument = findInstrument({ figi });
  if (!instrument) {
    return res.status(404).json({
      trackingId: getTrackId(),
      status: 'Error',
      payload: {
        message: `Instrument not find by figi=${figi}`,
        code: 'NOT_FOUND'
      }
    });
  }
  const lots = ~~(balance / instrument.lot);
  positions[instrument.figi] = {
    figi: instrument.figi,
    name: instrument.name,
    ticker: instrument.ticker,
    isin: instrument.isin,
    instrumentType: instrument.type,
    balance: lots * instrument.lot,
    lots: lots
  };
  res.json({
    trackingId: getTrackId(),
    status: 'Ok',
    payload: {}
  });
});

app.post('/sandbox/remove', function(req, res) {
  res.json({
    trackingId: getTrackId(),
    status: 'Ok',
    payload: {}
  });
});

app.post('/sandbox/clear', function(req, res) {
  res.json({
    trackingId: getTrackId(),
    status: 'Ok',
    payload: {}
  });
});

app.get('/orders', function(req, res) {
  res.json({
    trackingId: getTrackId(),
    status: 'Ok',
    payload: []
  });
});

app.post('/orders/limit-order', function(req, res) {
  res.status(501).json({
    trackingId: getTrackId(),
    status: 'Error',
    payload: {
      message: 'Not Implemented',
      code: 'NOT_IMPLEMENTED'
    }
  });
});

app.post('/orders/market-order', function(req, res) {
  const { figi } = req.query;
  const { lots, operation } = req.body;
  const instrument = findInstrument({ figi });
  if (!instrument) {
    return res.status(404).json({
      trackingId: getTrackId(),
      status: 'Error',
      payload: {
        message: `Instrument not find by figi=${figi}`,
        code: 'NOT_FOUND'
      }
    });
  }
  const candle = current[figi];
  const price = current[figi].c;
  const op = {
    id: String(operations.length + 1),
    status: 'Done',
    operationType: operation,
    date: candle.time,
    isMarginCall: false,
    instrumentType: instrument.type,
    figi: figi,
    quantity: lots,
    price: price,
    payment: operation === 'Sell' ? price * lots : -price * lots,
    currency: instrument.currency
  };
  const prev = positions[figi];
  const volume = prev ? prev.lots + lots * (operation === 'Sell' ? -1 : 1) : lots;
  if (volume > 0) {
    positions[figi] = {
      figi: instrument.figi,
      ticker: instrument.ticker,
      isin: instrument.isin,
      instrumentType: instrument.type,
      name: instrument.name,
      lots: volume,
      balance: volume * instrument.lot,
      averagePositionPrice: {
        currency: instrument.currency,
        // avg2_price = (avg1_price * avg1_lots + price * lots) / (avg1_lots + lots)
        value: prev ? (prev.averagePositionPrice.value * prev.lots + price * lots) / (prev.lots + lots) : price
      },
      get expectedYield() {
        const price = (current[this.figi] || {}).c;
        if (!price) return;
        return {
          currency: this.averagePositionPrice.currency,
          value: (price - this.averagePositionPrice.value) * this.lots
        };
      }
    };
  } else {
    delete positions[figi];
  }
  balance[instrument.currency].balance += op.payment;
  res.json({
    trackingId: getTrackId(),
    status: 'Ok',
    payload: {
      orderId: getOrderId(),
      operation: operation,
      status: 'Fill',
      requestedLots: lots,
      executedLots: lots
    }
  });
});

app.post('​/orders​/cancel', function(req, res) {
  res.status(501).json({
    trackingId: getTrackId(),
    status: 'Error',
    payload: {
      message: 'Not Implemented',
      code: 'NOT_IMPLEMENTED'
    }
  });
});

app.get('/portfolio', function(req, res) {
  res.json({
    trackingId: getTrackId(),
    status: 'Ok',
    payload: {
      positions: Object.keys(positions).map(key => positions[key])
    }
  });
});

app.get('/portfolio/currencies', function(req, res) {
  res.json({
    trackingId: getTrackId(),
    status: 'Ok',
    payload: {
      currencies: Object.keys(balance).map(key => balance[key])
    }
  });
});

app.get('/market/stocks', function(req, res) {
  res.json({
    trackingId: getTrackId(),
    status: 'Ok',
    payload: {
      instruments: stocks,
      total: stocks.length
    }
  });
});

app.get('/market/bonds', function(req, res) {
  res.json({
    trackingId: getTrackId(),
    status: 'Ok',
    payload: {
      instruments: bonds,
      total: bonds.length
    }
  });
});

app.get('/market/etfs', function(req, res) {
  res.json({
    trackingId: getTrackId(),
    status: 'Ok',
    payload: {
      instruments: etfs,
      total: etfs.length
    }
  });
});

app.get('​/market​/currencies', function(req, res) {
  res.json({
    trackingId: getTrackId(),
    status: 'Ok',
    payload: {
      instruments: currencies,
      total: currencies.length
    }
  });
});

app.get('​/market/orderbook', function(req, res) {
  res.status(501).json({
    trackingId: getTrackId(),
    status: 'Error',
    payload: {
      message: 'Not Implemented',
      code: 'NOT_IMPLEMENTED'
    }
  });
});

app.get('/market/candles', function(req, res) {
  const { figi, from, to, interval } = req.query;
  res.json({
    trackingId: getTrackId(),
    status: 'Ok',
    payload: {
      figi: figi,
      interval: interval,
      candles: (candles[figi] || []).filter(candle => {
        return candle.time > from && candle.time <= to;
      })
    }
  });
});

app.get('/market/search/by-figi', function(req, res) {
  const { figi } = req.query;
  const instrument = findInstrument({ figi });
  if (!instrument) {
    return res.status(404).json({
      trackingId: getTrackId(),
      status: 'Error',
      payload: {
        message: `Instrument not find by figi=${figi}`,
        code: 'NOT_FOUND'
      }
    });
  }
  res.json({
    trackingId: getTrackId(),
    status: 'Ok',
    payload: instrument
  });
});

app.get('/market/search/by-ticker', function(req, res) {
  const { ticker } = req.query;
  const instruments = filterInstruments({ ticker });
  if (!instruments.length) {
    return res.status(404).json({
      trackingId: getTrackId(),
      status: 'Error',
      payload: {
        message: `Instrument not find by ticker=${ticker}`,
        code: 'NOT_FOUND'
      }
    });
  }
  res.json({
    trackingId: getTrackId(),
    status: 'Ok',
    payload: {
      instruments: instruments,
      total: instruments.length
    }
  });
});

app.get('/operations', function(req, res) {
  res.json({
    trackingId: getTrackId(),
    status: 'Ok',
    payload: {
      operations: operations
    }
  });
});

app.get('/user/accounts', function(req, res) {
  res.json({
    trackingId: getTrackId(),
    status: 'Ok',
    payload: {
      accounts: [{
        brokerAccountType: 'Tinkoff',
        brokerAccountId: '1'
      }]
    }
  });
});

const server = app.listen(nconf.get('port'), nconf.get('host'));

const subscribes = {};
const wss = new WebSocket.Server({ noServer: true });
wss.on('connection', socket => {
  subscribes[socket.id] = {};
  socket.on('message', message => {
    if (typeof message !== 'string') return;
    const { event, figi, interval } = JSON.parse(message);
    if (event === 'candle:subscribe') {
      subscribes[socket.id][`${figi}-${interval}`] = { figi, interval };
    }
    if (event === 'candle:unsubscribe') {
      if (subscribes[socket.id][`${figi}-${interval}`]) {
        delete subscribes[socket.id][`${figi}-${interval}`];
        if (!Object.keys(subscribes[socket.id]).length) {
          delete subscribes[socket.id];
        }
      }
    }
  });
  socket.on('disconnect', () => {
    delete subscribes[socket.id];
  });
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, socket => {
    wss.emit('connection', socket, request);
  });
});

const counter = {};

setInterval(() => {
  for (const figi in candles) {
    if (!counter[figi]) counter[figi] = 0;
    const candle = candles[figi][counter[figi]++];
    if (candle) {
      current[figi] = candle;
    }
  }
  wss.clients.forEach(client => {
    if (!subscribes[client.id]) return;
    for (const k in subscribes[client.id]) {
      const data = subscribes[client.id][k];
      const candle = current[data.figi];
      if (!candle) continue;
      client.send(JSON.stringify({
        event: 'candle',
        time: candle.time,
        payload: candle
      }));
    }
  });
}, 100);
