#ifndef LCD_MODE_H
#define LCD_MODE_H
#include "stm32f1xx_hal.h"
#include <stdint.h>
#include <stdbool.h>
#define LCD_SIDEBAR_WIDTH 64U
#define LCD_PLOT_COLUMNS 256U
/* 500 kSa/s = 500 mau/ms. Cua so 2 ms phu hop de xem xung 1-10 kHz. */
#define LCD_FRAME_SPAN_MS 2U
#define LCD_FRAME_SAMPLES (500U * LCD_FRAME_SPAN_MS)
#define LCD_RECORD_SAMPLES 4096U
#define LCD_SCROLL_STEP_PIXELS 3U
#if LCD_FRAME_SAMPLES > LCD_RECORD_SAMPLES
#error "LCD span must fit the 4096-sample recording (max 8 ms at 500 kSa/s)"
#endif
typedef struct
{
  uint8_t low;
  uint8_t high;
  uint8_t edges;
} LCD_Column;
typedef struct
{
  uint8_t pixels[128];
  uint8_t recording[LCD_RECORD_SAMPLES];
  uint16_t recorded_samples;
  uint16_t playback_offset;
} LCD_Stream;
void LCD_StreamReset(LCD_Stream *stream);
bool LCD_RecordAppend(LCD_Stream *stream, const uint8_t *samples, uint16_t count);
/* Cot tuyet doi tren luoi thoi gian; chi tra ve cot co du mau hop le. */
bool LCD_GetColumn(const LCD_Stream *stream, uint16_t column, LCD_Column *result);

/* Khoi tao ILI9341 va xu ly Start/Stop, render waveform theo tung buoc. */
void Display_Init(SPI_HandleTypeDef *spi);
void Display_Task(void);
#endif
