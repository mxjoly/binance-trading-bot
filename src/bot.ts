import winston from 'winston';
import Binance, {
  Candle,
  CandleChartInterval,
  CandleChartResult,
  ExchangeInfo,
  Order,
  PositionRiskResult,
  TradeResult,
} from 'binance-api-node';
import technicalIndicators, {
  RSI,
  CROSS_SMA,
  SMA,
  RSI_SMA,
} from './indicators';
import {
  tradeConfigs,
  BINANCE_MODE,
  MAX_CANDLES_HISTORY,
  MIN_FREE_BALANCE_FOR_FUTURE_TRADING,
  MIN_FREE_BALANCE_FOR_SPOT_TRADING,
} from './config';

require('dotenv').config();

// ====================================================================== //

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.simple(),
  transports: [new winston.transports.File({ filename: 'bot.log' })],
});

const binanceClient = Binance({
  apiKey: process.env.BINANCE_PUBLIC_KEY,
  apiSecret: process.env.BINANCE_PRIVATE_KEY,
});

const historyCandles: { [pair: string]: ChartCandle[] } = {};

// All open orders in futures
const openOrders: { [pair: string]: number[] } = {};

// ====================================================================== //

function prepare() {
  // Initialize history and open orders
  tradeConfigs.forEach((tradeConfig) => {
    const pair = tradeConfig.asset + tradeConfig.base;
    historyCandles[pair] = [];
    openOrders[pair] = [];
  });

  if (BINANCE_MODE === 'futures') {
    // Set the margin type and initial leverage for the futures
    tradeConfigs.forEach((tradeConfig) => {
      binanceClient
        .futuresMarginType({
          symbol: tradeConfig.asset + tradeConfig.base,
          marginType: 'ISOLATED',
        })
        .catch(error);

      binanceClient
        .futuresLeverage({
          symbol: tradeConfig.asset + tradeConfig.base,
          leverage: tradeConfig.leverage || 2,
        })
        .catch(error);
    });
  }
}

/**
 * Load candles and add them to the history
 */
function loadCandles(symbol: string, interval: CandleChartInterval) {
  return new Promise((resolve, reject) => {
    const getCandles =
      BINANCE_MODE === 'spot'
        ? binanceClient.candles
        : binanceClient.futuresCandles;

    getCandles({ symbol, interval })
      .then((candles) => {
        historyCandles[symbol] = candles
          .slice(-MAX_CANDLES_HISTORY)
          .map((candle) => ChartCandle(candle));
      })
      .then(() => {
        log(
          `@${BINANCE_MODE} > The candles for the pair ${symbol} are successfully loaded`
        );
      })
      .then(resolve)
      .catch(reject);
  });
}

async function run() {
  log('====================== Binance Bot Trading ======================');

  const exchangeInfo =
    BINANCE_MODE === 'spot'
      ? await binanceClient.exchangeInfo()
      : await binanceClient.futuresExchangeInfo();

  tradeConfigs.forEach((tradeConfig) => {
    const pair = tradeConfig.asset + tradeConfig.base;

    loadCandles(pair, tradeConfig.interval)
      .then(() => {
        log(`@${BINANCE_MODE} > The bot trades the pair ${pair}`);

        const getCandles =
          BINANCE_MODE === 'spot'
            ? binanceClient.ws.candles
            : // @ts-ignore
              binanceClient.ws.futuresCandles;

        getCandles(pair, tradeConfig.interval, (candle: Candle) => {
          let candles = historyCandles[pair];

          // Add only the closed candles
          if (candle.isFinal) {
            candles.push(ChartCandle(candle));
            candles = candles.slice(1);

            if (BINANCE_MODE === 'spot') {
              tradeWithSpot(
                tradeConfig,
                candles,
                Number(candle.close),
                exchangeInfo
              );
            } else {
              tradeWithFutures(
                tradeConfig,
                candles,
                Number(candle.close),
                exchangeInfo
              );
            }
          }
        });
      })
      .catch(error);
  });
}

async function tradeWithSpot(
  tradeConfig: TradeConfig,
  candles: ChartCandle[],
  realtimePrice: number,
  exchangeInfo: ExchangeInfo
) {
  const pair = `${tradeConfig.asset}${tradeConfig.base}`;

  // Ge the available balance of base asset
  const { balances } = await binanceClient.accountInfo();
  const availableBalance = Number(
    balances.find((balance) => balance.asset === tradeConfig.base).free
  );

  const currentTrades = await binanceClient.myTrades({ symbol: pair });

  // If a trade exists, search when to sell
  if (currentTrades.length > 0) {
    const openTrade = currentTrades[0];

    if (isSellSignal(candles)) {
      binanceClient
        .order({
          side: 'SELL',
          type: 'MARKET',
          symbol: openTrade.symbol,
          quantity: openTrade.qty,
          recvWindow: 60000,
        })
        .then(() => {
          log(
            `@Spot > Bot sold ${openTrade.symbol} to ${
              tradeConfig.base
            }. Gain: ${
              realtimePrice * Number(openTrade.qty) -
              Number(openTrade.price) * Number(openTrade.qty)
            }`
          );
        })
        .catch(error);
    }
  } else if (availableBalance >= MIN_FREE_BALANCE_FOR_SPOT_TRADING) {
    if (isBuySignal(candles)) {
      const takeProfitPrice = tradeConfig.profitTarget
        ? calculatePrice(realtimePrice, 1 + tradeConfig.profitTarget)
        : null;
      const stopLossPrice = calculatePrice(
        realtimePrice,
        1 - tradeConfig.lossTolerance
      );

      const quantity = getQuantity(
        pair,
        availableBalance,
        tradeConfig.allocation,
        realtimePrice,
        exchangeInfo
      );

      // Buy limit order
      binanceClient
        .order({
          side: 'BUY',
          type: 'MARKET',
          symbol: pair,
          quantity: String(quantity),
          recvWindow: 60000,
        })
        .then(() => {
          if (takeProfitPrice) {
            // Sell oco order as TP/SL
            binanceClient
              .orderOco({
                side: 'SELL',
                symbol: pair,
                price: String(takeProfitPrice),
                stopPrice: String(stopLossPrice),
                stopLimitPrice: String(stopLossPrice),
                quantity: String(quantity),
                recvWindow: 60000,
              })
              .catch(error);
          } else {
            // Sell limit order as SL
            binanceClient
              .order({
                side: 'SELL',
                type: 'LIMIT',
                symbol: pair,
                price: String(stopLossPrice),
                quantity: String(quantity),
                recvWindow: 60000,
              })
              .catch(error);
          }
        })
        .then(() => {
          log(
            `@Spot > Bot bought ${tradeConfig.asset} with ${
              tradeConfig.base
            } at the price ${realtimePrice}. TP/SL: ${
              takeProfitPrice ? takeProfitPrice : '----'
            }/${stopLossPrice}`
          );
        })
        .catch(error);
    }
  }
}

async function tradeWithFutures(
  tradeConfig: TradeConfig,
  candles: ChartCandle[],
  realtimePrice: number,
  exchangeInfo: ExchangeInfo
) {
  const pair = `${tradeConfig.asset}${tradeConfig.base}`;

  // Ge the available balance of base asset
  const balances = await binanceClient.futuresAccountBalance();
  const availableBalance = Number(
    balances.find((balance) => balance.asset === tradeConfig.base)
      .availableBalance
  );

  const position = (await binanceClient.futuresPositionRisk()).filter(
    (position) => position.symbol === pair
  )[0];

  /**
   * Check if the current position must be close or not.
   */
  function checkCurrentPosition(position: PositionRiskResult) {
    return new Promise<void>((resolve, reject) => {
      const isBuyPosition = position.entryPrice > position.liquidationPrice;

      // Avoid to take a position two times when different indicators returns a signal successively
      if (!isBuyPosition && isBuySignal(candles)) {
        binanceClient
          .futuresOrder({
            side: 'BUY',
            type: 'MARKET',
            symbol: pair,
            quantity: position.positionAmt,
            recvWindow: 60000,
          })
          .then(() => {
            closeOpenOrders(pair);
            log(
              `@Futures > Close the long position for ${pair}. PNL: ${position.unRealizedProfit}`
            );
          })
          .then(resolve)
          .catch(reject);
      } else if (isBuyPosition && isSellSignal(candles)) {
        binanceClient
          .futuresOrder({
            side: 'SELL',
            type: 'MARKET',
            symbol: pair,
            quantity: position.positionAmt,
            recvWindow: 60000,
          })
          .then(() => {
            closeOpenOrders(pair);
            log(
              `@Futures > Close the short position for ${pair}. PNL: ${position.unRealizedProfit}`
            );
          })
          .then(resolve)
          .catch(reject);
      } else {
        resolve();
      }
    });
  }

  /**
   * Look for a position to take
   */
  function lookForPosition() {
    // Allow trading with a minimum of balance
    if (availableBalance >= MIN_FREE_BALANCE_FOR_FUTURE_TRADING) {
      if (isBuySignal(candles)) {
        const takeProfitPrice = tradeConfig.profitTarget
          ? calculatePrice(realtimePrice, 1 + tradeConfig.profitTarget)
          : null;
        const stopLossPrice = calculatePrice(
          realtimePrice,
          1 - tradeConfig.lossTolerance
        );

        const quantity = getQuantity(
          pair,
          availableBalance,
          tradeConfig.allocation,
          realtimePrice,
          exchangeInfo
        );

        // Buy limit order
        binanceClient
          .futuresOrder({
            side: 'BUY',
            type: 'MARKET',
            symbol: pair,
            quantity: String(quantity),
            recvWindow: 60000,
          })
          .then(() => {
            if (takeProfitPrice) {
              // Take profit order
              binanceClient
                .futuresOrder({
                  side: 'SELL',
                  type: 'TAKE_PROFIT_MARKET',
                  symbol: pair,
                  stopPrice: String(takeProfitPrice),
                  quantity: String(quantity),
                  recvWindow: 60000,
                })
                .then((order) => {
                  openOrders[pair].push(order.orderId);
                })
                .catch(error);
            }

            // Stop loss order
            binanceClient
              .futuresOrder({
                side: 'SELL',
                type: 'STOP_MARKET',
                symbol: pair,
                stopPrice: String(stopLossPrice),
                quantity: String(quantity),
                recvWindow: 60000,
              })
              .then((order) => {
                openOrders[pair].push(order.orderId);
              })
              .catch(error);
          })
          .then(() => {
            log(
              `@Futures > Bot takes a long for ${pair} at the price ${realtimePrice} with TP/SL: ${
                takeProfitPrice ? takeProfitPrice : '----'
              }/${stopLossPrice}`
            );
          })
          .catch(error);
      } else if (isSellSignal(candles)) {
        const takeProfitPrice = tradeConfig.profitTarget
          ? calculatePrice(realtimePrice, 1 - tradeConfig.profitTarget)
          : null;
        const stopLossPrice = calculatePrice(
          realtimePrice,
          1 + tradeConfig.lossTolerance
        );

        const quantity = getQuantity(
          pair,
          availableBalance,
          tradeConfig.allocation,
          realtimePrice,
          exchangeInfo
        );

        // Sell limit order
        binanceClient
          .futuresOrder({
            side: 'SELL',
            type: 'MARKET',
            symbol: pair,
            quantity: String(quantity),
            recvWindow: 60000,
          })
          .then(() => {
            if (takeProfitPrice) {
              // Take profit order
              binanceClient
                .futuresOrder({
                  side: 'BUY',
                  type: 'TAKE_PROFIT_MARKET',
                  symbol: pair,
                  stopPrice: String(takeProfitPrice),
                  quantity: String(quantity),
                  recvWindow: 60000,
                })
                .then((order) => {
                  openOrders[pair].push(order.orderId);
                })
                .catch(error);
            }

            // Stop loss order
            binanceClient
              .futuresOrder({
                side: 'BUY',
                type: 'STOP_MARKET',
                symbol: pair,
                stopPrice: String(stopLossPrice),
                quantity: String(quantity),
                recvWindow: 60000,
              })
              .then((order) => {
                openOrders[pair].push(order.orderId);
              })
              .catch(error);
          })
          .then(() => {
            log(
              `@Futures > Bot takes a short for ${pair} at the price ${realtimePrice} with TP/SL: ${
                takeProfitPrice ? takeProfitPrice : '----'
              }/${stopLossPrice}`
            );
          })
          .catch(error);
      } else {
        log('@futures > Waiting to find the trade...');
      }
    }
  }

  if (Number(position.positionAmt) > 0) {
    // There is only one position for a crypto
    // Used when we need to close a position and open directly a new position
    checkCurrentPosition(position).then(lookForPosition).catch(error);
  } else {
    if (openOrders[pair].length > 0) {
      closeOpenOrders(pair);
    }
    lookForPosition();
  }
}

function closeOpenOrders(symbol: string) {
  openOrders[symbol].forEach((order) => {
    const cancel =
      BINANCE_MODE === 'spot'
        ? binanceClient.cancelOrder
        : binanceClient.futuresCancelOrder;

    cancel({ symbol, orderId: order })
      .then(() => {
        log(
          `@${BINANCE_MODE} > Close all the open orders for the pair ${symbol}`
        );
      })
      .catch(error);
  });
  openOrders[symbol] = []; // reset the list of order id
}

// ==================================================================================== //

function ChartCandle(candle: Candle | CandleChartResult): ChartCandle {
  return {
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: Number(candle.volume),
    closeTime: Number(candle.closeTime),
    trades: Number(candle.trades),
  };
}

/**
 * Calculate a new price by apply a percentage
 */
function calculatePrice(price: number, percent: number) {
  const precision = getPrecision(price);
  const newPrice = price * percent;
  const newPricePrecision = getPrecision(newPrice);
  return newPricePrecision > precision
    ? Number(newPrice.toFixed(precision))
    : newPrice;
}

function isBuySignal(candles: ChartCandle[]) {
  const data = {
    open: candles.map((candle) => candle.open),
    high: candles.map((candle) => candle.high),
    close: candles.map((candle) => candle.close),
    low: candles.map((candle) => candle.low),
  };
  return (
    // technicalIndicators.bullish(data) ||
    // CROSS_SMA.isBuySignal(candles) ||
    RSI.isBuySignal(candles) || SMA.isBuySignal(candles)
  );
}

function isSellSignal(candles: ChartCandle[]) {
  const data = {
    open: candles.map((candle) => candle.open),
    high: candles.map((candle) => candle.high),
    close: candles.map((candle) => candle.close),
    low: candles.map((candle) => candle.low),
  };
  return (
    // technicalIndicators.bearish(data) ||
    // CROSS_SMA.isSellSignal(candles) ||
    RSI.isSellSignal(candles) || SMA.isSellSignal(candles)
  );
}

/**
 * Get the quantity of a crypto to trade according to the available balance,
 * the allocation to take, and the price of the crypto
 */
function getQuantity(
  pair: string,
  availableBalance: number,
  allocation: number,
  price: number,
  exchangeInfo: ExchangeInfo
) {
  const minQuantity = Number(
    exchangeInfo.symbols
      .find((symbol) => symbol.symbol === pair)
      // @ts-ignore
      .filters.find((filter) => filter.filterType === 'LOT_SIZE').minQty
  );

  // Get the number of decimals
  const minQuantityFormatted = Number(minQuantity).toString(); // Remove useless 0 at the end
  const hasDecimals = minQuantityFormatted.split('.').length === 2;
  const minQuantityPrecision = hasDecimals
    ? minQuantityFormatted.split('.')[1].length
    : 0;

  const quantity = Number(
    ((availableBalance * allocation) / price).toFixed(minQuantityPrecision)
  );

  return quantity > minQuantity ? quantity : minQuantity;
}

/**
 * Get the number of decimals
 */
function getPrecision(number: number) {
  return String(number).split('.').length === 2
    ? String(number).split('.')[1].length
    : 0;
}

function log(message: string) {
  logger.info(message);
  console.log(`${new Date(Date.now())} : ${message}`);
}

function error(message: string) {
  logger.warn(message);
  console.error(`${new Date(Date.now())} : ${message}`);
}

prepare();
run();
