#include "lcd_mode.h"
#include "acquisition.h"
#include <stdio.h>
#include <string.h>

void LCD_StreamReset(LCD_Stream *stream)
{
  memset(stream, 0, sizeof(*stream));
}

bool LCD_RecordAppend(LCD_Stream *stream, const uint8_t *samples, uint16_t count)
{
  uint16_t remaining = (uint16_t)(LCD_RECORD_SAMPLES - stream->recorded_samples);
  if (count > remaining) count = remaining;
  memcpy(&stream->recording[stream->recorded_samples], samples, count);
  stream->recorded_samples += count;
  return stream->recorded_samples == LCD_RECORD_SAMPLES;
}

/* Bin k chua mau ceil(k*N/W)..ceil((k+1)*N/W)-1.
   Luoi nay co dinh trong ca ban ghi, khong gom lai khi doi cua so. */
static uint32_t ColumnStart(uint16_t column)
{
  return ((uint32_t)column * LCD_FRAME_SAMPLES + LCD_PLOT_COLUMNS - 1U) /
         LCD_PLOT_COLUMNS;
}

bool LCD_GetColumn(const LCD_Stream *stream, uint16_t column, LCD_Column *result)
{
  uint32_t first = ColumnStart(column);
  uint32_t end = ColumnStart((uint16_t)(column + 1U));
  uint32_t i;
  uint8_t previous_low = 0U, previous_high = 0U;
  if (column == 0xFFFFU || first >= end || end > stream->recorded_samples)
    return false;
  memset(result, 0, sizeof(*result));
  for (i = first; i < end; i++)
  {
    uint8_t sample = stream->recording[i];
    result->low |= (uint8_t)~sample;
    result->high |= sample;
  }
  result->edges = (uint8_t)(result->low & result->high);
  if (column != 0U)
  {
    for (i = ColumnStart((uint16_t)(column - 1U)); i < first; i++)
    {
      previous_low |= (uint8_t)~stream->recording[i];
      previous_high |= stream->recording[i];
    }
    result->edges |= (uint8_t)(
      (previous_low & (uint8_t)~previous_high & result->high & (uint8_t)~result->low) |
      (previous_high & (uint8_t)~previous_low & result->low & (uint8_t)~result->high));
  }
  return true;
}

/* Chan CubeMX hien tai: PB10=DC, PB11=RST, PB12=CS. */
#define LCD_PORT GPIOB
#define LCD_DC_PIN GPIO_PIN_10
#define LCD_RST_PIN GPIO_PIN_11
#define LCD_CS_PIN GPIO_PIN_12
#define COLOR_BLACK 0x0000U
#define COLOR_NAVY 0x000FU
#define COLOR_GRID 0x2945U
#define COLOR_WHITE 0xFFFFU
#define COLOR_CYAN 0x07FFU
#define COLOR_GREEN 0x07E0U
#define COLOR_ORANGE 0xFD20U
#define COLOR_RED 0xF800U
#define LCD_WIDTH 320U
#define LCD_HEIGHT 240U
#define LANE_HEIGHT 30U
#define BUTTON_COUNT 2U
#define DEBOUNCE_MS 20U
#define LCD_RENDER_PERIOD_MS 100U
#define LCD_BOOT_COLOR_TEST 1U

typedef struct
{
  uint16_t pin;
  bool raw, stable;
  uint32_t changed_at;
} ButtonState;

typedef enum { DRAW_IDLE, DRAW_INITIAL, DRAW_SCROLL } DrawMode;

static SPI_HandleTypeDef *lcd_spi;
static LCD_Stream *stream;
static bool spi_failed, display_error;
static volatile uint8_t lcd_init_stage;
static bool playback_running, playback_finished, stop_requested, initial_ready;
static DrawMode draw_mode;
static uint16_t scroll_head, left_column, pending_head, pending_left;
static uint16_t columns_done, columns_needed, column_y;
static uint16_t physical_x, absolute_column;
static LCD_Column column_masks;
static uint32_t last_step_tick, step_started_tick, fps_tick, committed_steps, fps;
static volatile uint32_t frame_render_ms;
static LA_State last_state;
/* 16 o thong tin, moi o toi da 7 ky tu. Chi ve lai o thay doi. */
static char sidebar_text[16][8];
static uint16_t sidebar_dirty;
static uint8_t sidebar_line, sidebar_row;
static ButtonState buttons[BUTTON_COUNT] =
{
  {GPIO_PIN_6, true, true, 0U},
  {GPIO_PIN_7, true, true, 0U}
};

static void LcdSelect(bool select)
{
  HAL_GPIO_WritePin(LCD_PORT, LCD_CS_PIN, select ? GPIO_PIN_RESET : GPIO_PIN_SET);
}

static void LcdCommand(uint8_t command)
{
  if (spi_failed) return;
  HAL_GPIO_WritePin(LCD_PORT, LCD_DC_PIN, GPIO_PIN_RESET);
  LcdSelect(true);
  if (HAL_SPI_Transmit(lcd_spi, &command, 1U, 2U) != HAL_OK) spi_failed = true;
  LcdSelect(false);
}

static void LcdData(const uint8_t *data, uint16_t length)
{
  if (spi_failed) return;
  HAL_GPIO_WritePin(LCD_PORT, LCD_DC_PIN, GPIO_PIN_SET);
  LcdSelect(true);
  if (HAL_SPI_Transmit(lcd_spi, (uint8_t *)(uintptr_t)data, length, 2U) != HAL_OK) spi_failed = true;
  LcdSelect(false);
}

static void LcdWrite(uint8_t command, const uint8_t *data, uint16_t length)
{
  LcdCommand(command);
  if (length != 0U)
  {
    LcdData(data, length);
  }
}

static void LcdResetAndConfigure(void)
{
  static const uint8_t power_b[] = {0x00U, 0xC1U, 0x30U};
  static const uint8_t power_seq[] = {0x64U, 0x03U, 0x12U, 0x81U};
  static const uint8_t driver_a[] = {0x85U, 0x00U, 0x78U};
  static const uint8_t power_a[] = {0x39U, 0x2CU, 0x00U, 0x34U, 0x02U};
  static const uint8_t pump[] = {0x20U};
  static const uint8_t driver_timing_b[] = {0x00U, 0x00U};
  static const uint8_t power1[] = {0x23U};
  static const uint8_t power2[] = {0x10U};
  static const uint8_t vcom1[] = {0x3EU, 0x28U};
  static const uint8_t vcom2[] = {0x86U};
  static const uint8_t madctl[] = {0x28U};
  static const uint8_t pixel[] = {0x55U};
  static const uint8_t frame[] = {0x00U, 0x18U};
  static const uint8_t display[] = {0x08U, 0x82U, 0x27U};
  static const uint8_t gamma_off[] = {0x00U};
  static const uint8_t gamma[] = {0x01U};

  HAL_GPIO_WritePin(LCD_PORT, LCD_CS_PIN | LCD_DC_PIN | LCD_RST_PIN,
                    GPIO_PIN_SET);
  HAL_GPIO_WritePin(LCD_PORT, LCD_RST_PIN, GPIO_PIN_RESET);
  HAL_Delay(20U);
  HAL_GPIO_WritePin(LCD_PORT, LCD_RST_PIN, GPIO_PIN_SET);
  HAL_Delay(120U);
  LcdCommand(0x01U); /* Software reset, doi controller on dinh. */
  HAL_Delay(150U);
  LcdWrite(0xCFU, power_b, sizeof(power_b));
  LcdWrite(0xEDU, power_seq, sizeof(power_seq));
  LcdWrite(0xE8U, driver_a, sizeof(driver_a));
  LcdWrite(0xCBU, power_a, sizeof(power_a));
  LcdWrite(0xF7U, pump, sizeof(pump));
  LcdWrite(0xEAU, driver_timing_b, sizeof(driver_timing_b));
  LcdWrite(0xC0U, power1, sizeof(power1));
  LcdWrite(0xC1U, power2, sizeof(power2));
  LcdWrite(0xC5U, vcom1, sizeof(vcom1));
  LcdWrite(0xC7U, vcom2, sizeof(vcom2));
  LcdWrite(0x36U, madctl, sizeof(madctl));
  LcdWrite(0x3AU, pixel, sizeof(pixel));
  LcdWrite(0xB1U, frame, sizeof(frame));
  LcdWrite(0xB6U, display, sizeof(display));
  LcdWrite(0xF2U, gamma_off, sizeof(gamma_off));
  LcdWrite(0x26U, gamma, sizeof(gamma));
  LcdCommand(0x11U);
  HAL_Delay(120U);
  LcdCommand(0x29U);
  HAL_Delay(20U);
}

static void LcdWindow(uint16_t x0, uint16_t y0, uint16_t x1, uint16_t y1)
{
  uint8_t data[4];

  data[0] = (uint8_t)(x0 >> 8);
  data[1] = (uint8_t)x0;
  data[2] = (uint8_t)(x1 >> 8);
  data[3] = (uint8_t)x1;
  LcdWrite(0x2AU, data, 4U);
  data[0] = (uint8_t)(y0 >> 8);
  data[1] = (uint8_t)y0;
  data[2] = (uint8_t)(y1 >> 8);
  data[3] = (uint8_t)y1;
  LcdWrite(0x2BU, data, 4U);
  LcdCommand(0x2CU);
}

static void FillRect(uint16_t x, uint16_t y, uint16_t width, uint16_t height,
                     uint16_t color)
{
  uint8_t pixels[128];
  uint32_t remaining;
  uint16_t i;

  if (spi_failed) return;
  if ((width == 0U) || (height == 0U) || (x >= LCD_WIDTH) || (y >= LCD_HEIGHT))
  {
    return;
  }
  if ((uint32_t)x + width > LCD_WIDTH) width = (uint16_t)(LCD_WIDTH - x);
  if ((uint32_t)y + height > LCD_HEIGHT) height = (uint16_t)(LCD_HEIGHT - y);
  remaining = (uint32_t)width * height;
  for (i = 0U; i < sizeof(pixels); i += 2U)
  {
    pixels[i] = (uint8_t)(color >> 8);
    pixels[i + 1U] = (uint8_t)color;
  }
  LcdWindow(x, y, (uint16_t)(x + width - 1U), (uint16_t)(y + height - 1U));
  HAL_GPIO_WritePin(LCD_PORT, LCD_DC_PIN, GPIO_PIN_SET);
  LcdSelect(true);
  while (remaining != 0U)
  {
    uint16_t count = (remaining > 64U) ? 64U : (uint16_t)remaining;
    if (HAL_SPI_Transmit(lcd_spi, pixels, (uint16_t)(count * 2U), 100U) != HAL_OK)
    {
      spi_failed = true;
      break;
    }
    remaining -= count;
  }
  LcdSelect(false);
}

static void DrawPixel(uint16_t x, uint16_t y, uint16_t color)
{
  FillRect(x, y, 1U, 1U, color);
}

static void Glyph(char character, uint8_t data[5])
{
  static const uint8_t digits[10][5] =
  {
    {0x3EU,0x51U,0x49U,0x45U,0x3EU},{0x00U,0x42U,0x7FU,0x40U,0x00U},
    {0x42U,0x61U,0x51U,0x49U,0x46U},{0x21U,0x41U,0x45U,0x4BU,0x31U},
    {0x18U,0x14U,0x12U,0x7FU,0x10U},{0x27U,0x45U,0x45U,0x45U,0x39U},
    {0x3CU,0x4AU,0x49U,0x49U,0x30U},{0x01U,0x71U,0x09U,0x05U,0x03U},
    {0x36U,0x49U,0x49U,0x49U,0x36U},{0x06U,0x49U,0x49U,0x29U,0x1EU}
  };
  static const uint8_t letters[26][5] =
  {
    {0x7EU,0x11U,0x11U,0x11U,0x7EU},{0x7FU,0x49U,0x49U,0x49U,0x36U},
    {0x3EU,0x41U,0x41U,0x41U,0x22U},{0x7FU,0x41U,0x41U,0x22U,0x1CU},
    {0x7FU,0x49U,0x49U,0x49U,0x41U},{0x7FU,0x09U,0x09U,0x09U,0x01U},
    {0x3EU,0x41U,0x49U,0x49U,0x7AU},{0x7FU,0x08U,0x08U,0x08U,0x7FU},
    {0x00U,0x41U,0x7FU,0x41U,0x00U},{0x20U,0x40U,0x41U,0x3FU,0x01U},
    {0x7FU,0x08U,0x14U,0x22U,0x41U},{0x7FU,0x40U,0x40U,0x40U,0x40U},
    {0x7FU,0x02U,0x0CU,0x02U,0x7FU},{0x7FU,0x04U,0x08U,0x10U,0x7FU},
    {0x3EU,0x41U,0x41U,0x41U,0x3EU},{0x7FU,0x09U,0x09U,0x09U,0x06U},
    {0x3EU,0x41U,0x51U,0x21U,0x5EU},{0x7FU,0x09U,0x19U,0x29U,0x46U},
    {0x46U,0x49U,0x49U,0x49U,0x31U},{0x01U,0x01U,0x7FU,0x01U,0x01U},
    {0x3FU,0x40U,0x40U,0x40U,0x3FU},{0x1FU,0x20U,0x40U,0x20U,0x1FU},
    {0x3FU,0x40U,0x78U,0x40U,0x3FU},{0x63U,0x14U,0x08U,0x14U,0x63U},
    {0x07U,0x08U,0x70U,0x08U,0x07U},{0x61U,0x51U,0x49U,0x45U,0x43U}
  };

  memset(data, 0, 5U);
  if ((character >= '0') && (character <= '9'))
    memcpy(data, digits[character - '0'], 5U);
  else if ((character >= 'A') && (character <= 'Z'))
    memcpy(data, letters[character - 'A'], 5U);
  else if (character == '-') memset(data, 0x08, 5U);
  else if (character == '=') memset(data, 0x14, 5U);
  else if (character == '/') { data[0]=0x20U; data[1]=0x10U; data[2]=0x08U; data[3]=0x04U; data[4]=0x02U; }
  else if (character == '%') { data[0]=0x62U; data[1]=0x64U; data[2]=0x08U; data[3]=0x13U; data[4]=0x23U; }
  else if (character == ':') { data[1]=0x36U; data[3]=0x36U; }
  else if (character == '.') { data[2]=0x60U; data[3]=0x60U; }
}

static void DrawText(uint16_t x, uint16_t y, const char *text, uint16_t color)
{
  uint8_t glyph[5];
  uint8_t column;
  uint8_t row;

  while ((*text != '\0') && (x < (LCD_WIDTH - 5U)))
  {
    Glyph(*text++, glyph);
    for (column = 0U; column < 5U; column++)
      for (row = 0U; row < 7U; row++)
        if ((glyph[column] & (1U << row)) != 0U)
          DrawPixel((uint16_t)(x + column), (uint16_t)(y + row), color);
    x = (uint16_t)(x + 6U);
  }
}



/* MV=1 (landscape): truc native 320 dong tro thanh truc X hien thi.
   Fixed 64 + scroll 256 + fixed 0 = 320. Khong bat Partial Mode. */
static void ScrollConfigure(void)
{
  static const uint8_t area[6] = {0U, 64U, 1U, 0U, 0U, 0U};
  LcdWrite(0x33U, area, sizeof(area));
}

static void ScrollStart(uint16_t head)
{
  uint16_t address = (uint16_t)(LCD_SIDEBAR_WIDTH + head);
  uint8_t data[2] = {(uint8_t)(address >> 8), (uint8_t)address};
  LcdWrite(0x37U, data, sizeof(data));
}

static void SetSidebar(uint8_t line, const char *text)
{
  if (strcmp(sidebar_text[line], text) != 0)
  {
    (void)snprintf(sidebar_text[line], sizeof(sidebar_text[line]), "%s", text);
    sidebar_dirty |= (uint16_t)(1U << line);
    if (sidebar_line == line) sidebar_row = 0U;
  }
}

static void RefreshSidebar(LA_State state)
{
  char text[8];
  const char *name = display_error ? "ERROR" :
                     (state == LA_STATE_STREAMING ? "REC" :
                      (playback_running ? "PLAY" : (initial_ready ? "" : "IDLE")));
  SetSidebar(0U, "500K"); SetSidebar(1U, "SA/S");
  (void)snprintf(text, sizeof(text), "%lu.%lu",
                 (unsigned long)(fps / 10U), (unsigned long)(fps % 10U));
  SetSidebar(2U, text); SetSidebar(3U, "FPS");
  SetSidebar(4U, "4096"); SetSidebar(5U, "SMP");
  SetSidebar(6U, ""); SetSidebar(7U, "");
  SetSidebar(8U, "START"); SetSidebar(9U, "PB6");
  SetSidebar(10U, "STOP"); SetSidebar(11U, "PB7");
  SetSidebar(12U, name); SetSidebar(13U, "");
  SetSidebar(14U, ""); SetSidebar(15U, "");
}

/* Thong so x=2..43 nam truoc nhan kenh x=48..59, khong cham vao waveform. */
static void SidebarStep(void)
{
  uint16_t i;
  uint8_t glyph[5] = {0};
  uint8_t cached_index = 0xFFU;
  uint16_t y;
  if (sidebar_line >= 16U)
  {
    for (sidebar_line = 0U; sidebar_line < 16U; sidebar_line++)
      if ((sidebar_dirty & (1U << sidebar_line)) != 0U) break;
    sidebar_row = 0U;
    if (sidebar_line == 16U) return;
  }
  y = (uint16_t)((sidebar_line / 2U) * LANE_HEIGHT +
                ((sidebar_line & 1U) ? 17U : 3U) + sidebar_row);
  for (i = 0U; i < 42U; i++)
  {
    uint8_t index = (uint8_t)(i / 6U), x = (uint8_t)(i % 6U);
    uint16_t color = COLOR_NAVY;
    if (index < strlen(sidebar_text[sidebar_line]) && x < 5U)
    {
      if (index != cached_index)
      {
        Glyph(sidebar_text[sidebar_line][index], glyph);
        cached_index = index;
      }
      if ((glyph[x] & (1U << sidebar_row)) != 0U)
        color = display_error ? COLOR_RED : COLOR_WHITE;
    }
    stream->pixels[i * 2U] = (uint8_t)(color >> 8);
    stream->pixels[i * 2U + 1U] = (uint8_t)color;
  }
  LcdWindow(2U, y, 43U, y);
  LcdData(stream->pixels, 84U);
  if (++sidebar_row == 7U)
  {
    sidebar_dirty &= (uint16_t)~(1U << sidebar_line);
    sidebar_line = 16U;
  }
}

static uint8_t ScanButtons(void)
{
  uint8_t pressed = 0U, i;
  uint32_t now = HAL_GetTick();
  for (i = 0U; i < BUTTON_COUNT; i++)
  {
    bool raw = HAL_GPIO_ReadPin(GPIOB, buttons[i].pin) != GPIO_PIN_RESET;
    if (raw != buttons[i].raw)
    {
      buttons[i].raw = raw;
      buttons[i].changed_at = now;
    }
    if (raw != buttons[i].stable && now - buttons[i].changed_at >= DEBOUNCE_MS)
    {
      buttons[i].stable = raw;
      if (!raw) pressed |= (uint8_t)(1U << i);
    }
  }
  return pressed;
}

static uint16_t LastLeftColumn(void)
{
  uint16_t full_columns = (uint16_t)((uint32_t)stream->recorded_samples *
                                    LCD_PLOT_COLUMNS / LCD_FRAME_SAMPLES);
  return full_columns >= LCD_PLOT_COLUMNS ?
         (uint16_t)(full_columns - LCD_PLOT_COLUMNS) : 0U;
}

static uint16_t ColumnPixel(uint16_t y)
{
  uint8_t lane = (uint8_t)(y / LANE_HEIGHT), row = (uint8_t)(y % LANE_HEIGHT);
  uint8_t mask = (uint8_t)(1U << lane);
  bool edge = (column_masks.edges & mask) != 0U;
  if ((row == 7U && (column_masks.high & mask)) ||
      (row == 22U && (column_masks.low & mask)) ||
      (row >= 7U && row <= 22U && edge))
    return (lane & 1U) ? COLOR_ORANGE : COLOR_CYAN;
  if (row == 15U || (absolute_column % 64U) == 0U) return COLOR_GRID;
  return COLOR_BLACK;
}

/* Ghi mot cot moi, chia thanh 4 lan goi (64+64+64+48 pixel).
   Old image chi bi sua o dai hep sap tai su dung; pointer doi SAU khi ghi du. */
static void DrawColumnStep(void)
{
  uint16_t count, i;
  if (column_y == 0U)
  {
    if (draw_mode == DRAW_INITIAL)
    {
      absolute_column = columns_done;
      physical_x = (uint16_t)(LCD_SIDEBAR_WIDTH + columns_done);
    }
    else
    {
      absolute_column = (uint16_t)(left_column + LCD_PLOT_COLUMNS + columns_done);
      physical_x = (uint16_t)(LCD_SIDEBAR_WIDTH +
                              (scroll_head + columns_done) % LCD_PLOT_COLUMNS);
    }
    if (!LCD_GetColumn(stream, absolute_column, &column_masks))
    {
      display_error = true;
      draw_mode = DRAW_IDLE;
      playback_running = false;
      playback_finished = true;
      return;
    }
  }
  count = (uint16_t)(LCD_HEIGHT - column_y);
  if (count > 64U) count = 64U;
  for (i = 0U; i < count; i++)
  {
    uint16_t color = ColumnPixel((uint16_t)(column_y + i));
    stream->pixels[i * 2U] = (uint8_t)(color >> 8);
    stream->pixels[i * 2U + 1U] = (uint8_t)color;
  }
  LcdWindow(physical_x, column_y, physical_x, (uint16_t)(column_y + count - 1U));
  LcdData(stream->pixels, (uint16_t)(count * 2U));
  if (spi_failed) return;
  column_y += count;
  if (column_y != LCD_HEIGHT) return;
  column_y = 0U;
  if (++columns_done != columns_needed) return;

  ScrollStart(pending_head); /* Commit mot lenh cho ca 8 kenh. */
  if (spi_failed) return;
  scroll_head = pending_head;
  left_column = pending_left;
  stream->playback_offset = (uint16_t)ColumnStart(left_column);
  initial_ready = true;
  draw_mode = DRAW_IDLE;
  committed_steps++;
  frame_render_ms = HAL_GetTick() - step_started_tick;
  if (stop_requested || left_column == LastLeftColumn())
  {
    playback_running = false;
    playback_finished = true;
  }
}

/* Khoi tao ILI9341 va ve sidebar, giu thu mau RGB da chay tren board. */
void Display_Init(SPI_HandleTypeDef *spi)
{
  uint8_t lane;
  uint32_t run_prescaler = spi->Init.BaudRatePrescaler;
  lcd_spi = spi;
  stream = LA_LcdWorkspace();
  LCD_StreamReset(stream);
  spi_failed = display_error = false;
  playback_running = playback_finished = stop_requested = initial_ready = false;
  draw_mode = DRAW_IDLE;
  scroll_head = left_column = pending_head = pending_left = 0U;
  columns_done = columns_needed = column_y = 0U;
  fps = committed_steps = frame_render_ms = 0U;
  fps_tick = HAL_GetTick();
  last_step_tick = fps_tick - LCD_RENDER_PERIOD_MS;
  memset(sidebar_text, 0, sizeof(sidebar_text));
  sidebar_dirty = 0U;
  sidebar_line = 16U;
  for (lane = 0U; lane < BUTTON_COUNT; lane++)
  {
    buttons[lane].raw = buttons[lane].stable = true;
    buttons[lane].changed_at = 0U;
  }

  lcd_spi->Init.BaudRatePrescaler = SPI_BAUDRATEPRESCALER_16;
  if (HAL_SPI_Init(lcd_spi) != HAL_OK) { spi_failed = true; display_error = true; return; }
  lcd_init_stage = 1U;
  LcdResetAndConfigure();
  lcd_init_stage = 2U;
  if (LCD_BOOT_COLOR_TEST && !spi_failed)
  {
    FillRect(0U, 0U, LCD_WIDTH, LCD_HEIGHT, COLOR_RED); HAL_Delay(200U);
    FillRect(0U, 0U, LCD_WIDTH, LCD_HEIGHT, COLOR_GREEN); HAL_Delay(200U);
    FillRect(0U, 0U, LCD_WIDTH, LCD_HEIGHT, 0x001FU); HAL_Delay(200U);
  }
  lcd_init_stage = 3U;
  ScrollConfigure();
  ScrollStart(0U);
  FillRect(0U, 0U, LCD_WIDTH, LCD_HEIGHT, COLOR_BLACK);
  FillRect(0U, 0U, LCD_SIDEBAR_WIDTH, LCD_HEIGHT, COLOR_NAVY);
  for (lane = 0U; lane < 8U; lane++)
  {
    char label[3] = {'D', (char)('0' + lane), '\0'};
    DrawText(48U, (uint16_t)(lane * LANE_HEIGHT + 12U), label,
             (lane & 1U) ? COLOR_ORANGE : COLOR_CYAN);
  }
  lcd_spi->Init.BaudRatePrescaler = run_prescaler;
  if (HAL_SPI_Init(lcd_spi) != HAL_OK) spi_failed = true;
  lcd_init_stage = 4U;
  last_state = LA_STATE_IDLE;
  display_error = spi_failed;
  RefreshSidebar(last_state);
}

void Display_Task(void)
{
  LA_Status status;
  uint8_t pressed = ScanButtons();
  uint32_t now = HAL_GetTick();
  LA_GetStatus(&status);
  if (pressed & 2U)
  {
    LA_Stop();
    stop_requested = true;
    playback_finished = true;
    if (draw_mode == DRAW_IDLE) playback_running = false;
    display_error = spi_failed;
  }
  else if ((pressed & 1U) && buttons[1].stable && !spi_failed && !display_error &&
           !playback_running && draw_mode == DRAW_IDLE && status.state != LA_STATE_STREAMING)
  {
    LCD_StreamReset(stream);
    initial_ready = stop_requested = playback_finished = false;
    scroll_head = left_column = 0U;
    fps = committed_steps = 0U;
    fps_tick = now;
    last_step_tick = now - LCD_RENDER_PERIOD_MS;
    ScrollStart(0U);
    if (!spi_failed) display_error = !LA_StartLcdPlayback();
  }
  LA_GetStatus(&status);
  if (status.state == LA_STATE_ERROR) display_error = true;

  if (!display_error && status.state == LA_STATE_COMPLETE && !playback_finished &&
      !initial_ready && draw_mode == DRAW_IDLE &&
      stream->recorded_samples >= LCD_FRAME_SAMPLES)
  {
    playback_running = true;
    draw_mode = DRAW_INITIAL;
    columns_done = column_y = 0U;
    columns_needed = LCD_PLOT_COLUMNS;
    pending_head = pending_left = 0U;
    step_started_tick = last_step_tick = now;
  }
  else if (playback_running && !stop_requested && draw_mode == DRAW_IDLE &&
           now - last_step_tick >= LCD_RENDER_PERIOD_MS)
  {
    uint16_t last = LastLeftColumn();
    if (left_column < last)
    {
      columns_needed = (uint16_t)(last - left_column);
      if (columns_needed > LCD_SCROLL_STEP_PIXELS) columns_needed = LCD_SCROLL_STEP_PIXELS;
      pending_left = (uint16_t)(left_column + columns_needed);
      pending_head = (uint16_t)((scroll_head + columns_needed) % LCD_PLOT_COLUMNS);
      columns_done = column_y = 0U;
      draw_mode = DRAW_SCROLL;
      step_started_tick = last_step_tick = now;
    }
  }

  if (!display_error && !spi_failed && draw_mode != DRAW_IDLE) DrawColumnStep();
  if (spi_failed)
  {
    LA_Stop();
    display_error = true;
    playback_running = false;
    playback_finished = true;
    draw_mode = DRAW_IDLE;
    return; /* Khong commit pointer sau loi SPI. */
  }
  if (now - fps_tick >= 1000U)
  {
    fps = committed_steps * 10000U / (now - fps_tick);
    committed_steps = 0U;
    fps_tick = now;
  }
  /* Chi thay doi text danh dau o dirty, khong reset tien do ve sidebar. */
  last_state = status.state;
  RefreshSidebar(last_state);
  if (draw_mode == DRAW_IDLE && sidebar_dirty != 0U) SidebarStep();
}
