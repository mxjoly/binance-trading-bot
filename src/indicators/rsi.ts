import { RSI } from 'technicalindicators';

const RSI_PERIOD = 14;
const RSI_OVERBOUGHT = 75;
const RSI_OVERSOLD = 35;

/**
 * Return true if the RSI crosses up the oversold zone line
 */
export const isBuySignal = (candles: ChartCandle[]) => {
  if (candles.length >= RSI_PERIOD) {
    const values = RSI.calculate({
      values: candles.map((candle) => candle.close),
      period: RSI_PERIOD,
    });

    const last = values[values.length - 2];
    const current = values[values.length - 1];

    // The RSI crossed the oversold line
    return last < RSI_OVERSOLD && current > RSI_OVERSOLD;
  }
};

/**
 * Return true if the RSI crosses down the overbought zone line
 */
export const isSellSignal = (candles: ChartCandle[]) => {
  if (candles.length >= RSI_PERIOD) {
    const values = RSI.calculate({
      values: candles.map((candle) => candle.close),
      period: RSI_PERIOD,
    });

    const last = values[values.length - 2];
    const current = values[values.length - 1];

    // The RSI crossed the overbought line
    return last > RSI_OVERBOUGHT && current < RSI_OVERBOUGHT;
  }
};
