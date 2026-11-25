#include "lcd_mode.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static struct { uint32_t before; LCD_Stream stream; uint32_t after; } guarded;
static uint8_t block[1024];

int main(void)
{
  LCD_Stream *s = &guarded.stream;
  uint32_t i, k, columns;
  guarded.before = 0x12345678U;
  guarded.after = 0x87654321U;
  assert(sizeof(*s) <= 8192U);
  LCD_StreamReset(s);
  for (i = 0; i < sizeof(block); i++) block[i] = (uint8_t)(i * 37U);
  for (i = 0; i < 4; i++)
    assert(LCD_RecordAppend(s, block, sizeof(block)) == (i == 3));
  assert(s->recorded_samples == LCD_RECORD_SAMPLES);
  assert(LCD_RecordAppend(s, block, sizeof(block)));
  columns = (uint32_t)s->recorded_samples * LCD_PLOT_COLUMNS / LCD_FRAME_SAMPLES;
  for (k = 0; k < columns; k++)
  {
    LCD_Column actual;
    uint8_t low = 0, high = 0, pl = 0, ph = 0, edges;
    /* Independent assignment: floor(sample*W/N) decides which bin owns it. */
    for (i = 0; i < s->recorded_samples; i++)
    {
      uint32_t bin = i * LCD_PLOT_COLUMNS / LCD_FRAME_SAMPLES;
      if (bin == k) { low |= (uint8_t)~s->recording[i]; high |= s->recording[i]; }
      if (k && bin == k - 1U) { pl |= (uint8_t)~s->recording[i]; ph |= s->recording[i]; }
    }
    edges = (uint8_t)((low & high) | (pl & (uint8_t)~ph & high & (uint8_t)~low) |
                      (ph & (uint8_t)~pl & low & (uint8_t)~high));
    assert(LCD_GetColumn(s, (uint16_t)k, &actual));
    assert(actual.low == low && actual.high == high && actual.edges == edges);
  }
  {
    LCD_Column actual;
    assert(!LCD_GetColumn(s, (uint16_t)columns, &actual)); /* partial tail excluded */
    assert(!LCD_GetColumn(s, 65535U, &actual));
  }
  for (i = 0; i < 2; i++)
  {
    uint32_t sample, pure_low = 0, pure_high = 0;
    uint32_t period = i ? 500U : 50U; /* 1kHz / 10kHz at 500kSa/s. */
    for (sample = 0; sample < s->recorded_samples; sample++)
      s->recording[sample] = (uint8_t)((sample % period) < period / 2U);
    for (k = 0; k < LCD_PLOT_COLUMNS; k++)
    {
      LCD_Column c;
      assert(LCD_GetColumn(s, (uint16_t)k, &c));
      pure_low += (c.low & 1U) && !(c.high & 1U);
      pure_high += (c.high & 1U) && !(c.low & 1U);
    }
    assert(pure_low > LCD_PLOT_COLUMNS / 3U && pure_high > LCD_PLOT_COLUMNS / 3U);
  }
  assert(guarded.before == 0x12345678U && guarded.after == 0x87654321U);
  LCD_StreamReset(s);
  assert(s->recorded_samples == 0 && s->playback_offset == 0);
  puts("LCD columns: raw bounds, absolute bins, edges, 1/10kHz and workspace PASS");
  return 0;
}
