#include "display_control.h"
#include "acquisition.h"
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

/* Mapping nay lay tu cau hinh CubeMX hien tai: PB10=DC, PB11=RST, PB12=CS. */
#define LCD_PORT       GPIOB
#define LCD_DC_PIN     GPIO_PIN_10
#define LCD_RST_PIN    GPIO_PIN_11
#define LCD_CS_PIN     GPIO_PIN_12

#define COLOR_BLACK    0x0000U
#define COLOR_NAVY     0x000FU
#define COLOR_DARK     0x1082U
#define COLOR_GRID     0x2945U
#define COLOR_WHITE    0xFFFFU
#define COLOR_CYAN     0x07FFU
#define COLOR_GREEN    0x07E0U
#define COLOR_YELLOW   0xFFE0U
#define COLOR_ORANGE   0xFD20U
#define COLOR_RED      0xF800U

#define LCD_WIDTH      320U
#define LCD_HEIGHT     240U
#define BUTTON_COUNT   5U
#define DEBOUNCE_MS    20U

typedef struct
{
  GPIO_TypeDef *port;
  uint16_t pin;
  bool raw;
  bool stable;
  uint32_t changed_at;
} ButtonState;

static SPI_HandleTypeDef *lcd_spi;
static uint8_t selected_item;
static bool redraw_requested;
static LA_State last_state;
static LA_Config last_config;
static bool last_config_valid;
static ButtonState buttons[BUTTON_COUNT] =
{
  {GPIOB, GPIO_PIN_5, true, true, 0U},
  {GPIOB, GPIO_PIN_6, true, true, 0U},
  {GPIOB, GPIO_PIN_7, true, true, 0U},
  {GPIOB, GPIO_PIN_8, true, true, 0U},
  {GPIOB, GPIO_PIN_9, true, true, 0U}
};

static const uint32_t rates[] =
{
  1000U, 5000U, 10000U, 50000U, 100000U, 500000U, 1000000U
};
static const uint16_t depths[] = {1024U, 2048U, 4096U, 8192U};

static void LcdSelect(bool select)
{
  HAL_GPIO_WritePin(LCD_PORT, LCD_CS_PIN, select ? GPIO_PIN_RESET : GPIO_PIN_SET);
}

static void LcdCommand(uint8_t command)
{
  HAL_GPIO_WritePin(LCD_PORT, LCD_DC_PIN, GPIO_PIN_RESET);
  LcdSelect(true);
  (void)HAL_SPI_Transmit(lcd_spi, &command, 1U, 20U);
  LcdSelect(false);
}

static void LcdData(const uint8_t *data, uint16_t length)
{
  HAL_GPIO_WritePin(LCD_PORT, LCD_DC_PIN, GPIO_PIN_SET);
  LcdSelect(true);
  (void)HAL_SPI_Transmit(lcd_spi, (uint8_t *)(uintptr_t)data, length, 100U);
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
  static const uint8_t driver_b[] = {0x00U, 0x00U};
  static const uint8_t pump[] = {0x20U};
  static const uint8_t ratio[] = {0x00U};
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
  LcdWrite(0xCFU, power_b, sizeof(power_b));
  LcdWrite(0xEDU, power_seq, sizeof(power_seq));
  LcdWrite(0xE8U, driver_a, sizeof(driver_a));
  LcdWrite(0xCBU, driver_b, sizeof(driver_b));
  LcdWrite(0xF7U, pump, sizeof(pump));
  LcdWrite(0xEAU, ratio, sizeof(ratio));
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
    (void)HAL_SPI_Transmit(lcd_spi, pixels, (uint16_t)(count * 2U), 100U);
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

static const char *StateName(LA_State state)
{
  switch (state)
  {
    case LA_STATE_IDLE: return "IDLE";
    case LA_STATE_ARMED: return "ARMED";
    case LA_STATE_TRIGGERED: return "TRIGGERED";
    case LA_STATE_COMPLETE: return "COMPLETE";
    case LA_STATE_STREAMING: return "STREAM";
    case LA_STATE_TIMEOUT: return "TIMEOUT";
    default: return "ERROR";
  }
}

static void DrawScreen(void)
{
  LA_Config cfg;
  LA_Status stat;
  char text[34];

  LA_GetConfig(&cfg);
  LA_GetStatus(&stat);
  FillRect(0U, 0U, LCD_WIDTH, LCD_HEIGHT, COLOR_BLACK);
  FillRect(0U, 0U, LCD_WIDTH, 24U, COLOR_NAVY);
  DrawText(8U, 8U, "STM32 LOGIC ANALYZER", COLOR_CYAN);
  DrawText(230U, 8U, StateName(stat.state),
           (stat.state == LA_STATE_ERROR) ? COLOR_RED : COLOR_GREEN);

  (void)snprintf(text, sizeof(text), "RATE %lu HZ", (unsigned long)cfg.actual_rate_hz);
  DrawText(8U, 31U, text, selected_item == 0U ? COLOR_YELLOW : COLOR_WHITE);
  (void)snprintf(text, sizeof(text), "DEPTH %u", (unsigned)cfg.sample_depth);
  DrawText(112U, 31U, text, selected_item == 1U ? COLOR_YELLOW : COLOR_WHITE);
  (void)snprintf(text, sizeof(text), "MODE %s", cfg.mode == LA_MODE_STREAM ? "STREAM" : "SNAP");
  DrawText(220U, 31U, text, selected_item == 2U ? COLOR_YELLOW : COLOR_WHITE);
  (void)snprintf(text, sizeof(text), "TRIG %s", cfg.trigger == LA_TRIGGER_NONE ? "NONE" :
                 (cfg.trigger == LA_TRIGGER_RISING ? "RISE" : "FALL"));
  DrawText(8U, 44U, text, selected_item == 3U ? COLOR_YELLOW : COLOR_WHITE);
  (void)snprintf(text, sizeof(text), "CH D%u", (unsigned)cfg.trigger_channel);
  DrawText(112U, 44U, text, selected_item == 4U ? COLOR_YELLOW : COLOR_WHITE);
  (void)snprintf(text, sizeof(text), "PRE %u%%", (unsigned)cfg.pretrigger_percent);
  DrawText(220U, 44U, text, selected_item == 5U ? COLOR_YELLOW : COLOR_WHITE);
  {
    uint32_t span_us = (uint32_t)(((uint64_t)cfg.sample_depth * 1000000ULL) /
                                  cfg.actual_rate_hz);
    if (span_us >= 1000U)
      (void)snprintf(text, sizeof(text), "SPAN %lu MS", (unsigned long)(span_us / 1000U));
    else
      (void)snprintf(text, sizeof(text), "SPAN %lu US", (unsigned long)span_us);
    DrawText(8U, 57U, text, COLOR_GRID);
    DrawText(112U, 57U, "UP/DOWN  OK  START/STOP", COLOR_GRID);
  }
  if (stat.state == LA_STATE_COMPLETE)
  {
    Display_DrawWaveform();
  }
}

void Display_DrawWaveform(void)
{
  LA_Status stat;
  static uint8_t visible_samples[LCD_WIDTH];
  static uint8_t row_pixels[LCD_WIDTH * 2U];
  uint16_t y;
  uint16_t x;
  uint16_t trigger_x;

  LA_GetStatus(&stat);
  if (stat.state != LA_STATE_COMPLETE)
  {
    return;
  }
  FillRect(0U, 70U, LCD_WIDTH, 170U, COLOR_BLACK);
  for (x = 0U; x < LCD_WIDTH; x++)
  {
    uint16_t index = (uint16_t)(((uint32_t)x * (stat.valid_samples - 1U)) /
                                 (LCD_WIDTH - 1U));
    (void)LA_ReadSamples(index, &visible_samples[x], 1U);
  }
  trigger_x = (stat.trigger_index < stat.valid_samples) ?
              (uint16_t)(((uint32_t)stat.trigger_index * (LCD_WIDTH - 1U)) /
                         (stat.valid_samples - 1U)) : 0xFFFFU;

  /* Ve theo tung dong 640 byte: khong can framebuffer 320x240 trong SRAM. */
  for (y = 70U; y < LCD_HEIGHT; y++)
  {
    for (x = 0U; x < LCD_WIDTH; x++)
    {
      uint16_t color = COLOR_BLACK;
      uint8_t channel;

      for (channel = 0U; channel < 8U; channel++)
      {
        uint16_t base = (uint16_t)(84U + channel * 19U);
        uint16_t level = ((visible_samples[x] & (1U << channel)) != 0U) ?
                         (uint16_t)(base - 6U) : (uint16_t)(base + 6U);
        bool transition = (x != 0U) &&
                          (((visible_samples[x - 1U] ^ visible_samples[x]) &
                            (1U << channel)) != 0U) &&
                          (y >= (base - 6U)) && (y <= (base + 6U));
        if ((y == level) || transition)
          color = (channel == 0U) ? COLOR_CYAN : COLOR_ORANGE;
        else if ((y == base) && (color == COLOR_BLACK))
          color = COLOR_GRID;
      }
      if (x == trigger_x) color = COLOR_YELLOW;
      row_pixels[x * 2U] = (uint8_t)(color >> 8);
      row_pixels[x * 2U + 1U] = (uint8_t)color;
    }
    LcdWindow(0U, y, LCD_WIDTH - 1U, y);
    LcdData(row_pixels, sizeof(row_pixels));
  }
}

static void ChangeSelectedSetting(void)
{
  LA_Config cfg;
  uint8_t i;

  LA_GetConfig(&cfg);
  if (selected_item == 0U)
  {
    for (i = 0U; i < (sizeof(rates) / sizeof(rates[0])); i++)
      if (rates[i] == cfg.requested_rate_hz) break;
    cfg.requested_rate_hz = rates[(i + 1U) % (sizeof(rates) / sizeof(rates[0]))];
    if ((cfg.mode == LA_MODE_STREAM) && (cfg.requested_rate_hz > 10000U))
      cfg.requested_rate_hz = 1000U;
  }
  else if (selected_item == 1U)
  {
    for (i = 0U; i < (sizeof(depths) / sizeof(depths[0])); i++)
      if (depths[i] == cfg.sample_depth) break;
    cfg.sample_depth = depths[(i + 1U) % (sizeof(depths) / sizeof(depths[0]))];
  }
  else if (selected_item == 2U)
  {
    cfg.mode = (cfg.mode == LA_MODE_SNAPSHOT) ? LA_MODE_STREAM : LA_MODE_SNAPSHOT;
    if ((cfg.mode == LA_MODE_STREAM) && (cfg.requested_rate_hz > 10000U))
      cfg.requested_rate_hz = 10000U;
  }
  else if (selected_item == 3U)
    cfg.trigger = (LA_Trigger)(((uint8_t)cfg.trigger + 1U) % 3U);
  else if (selected_item == 4U)
    cfg.trigger_channel = (uint8_t)((cfg.trigger_channel + 1U) % 8U);
  else
    cfg.pretrigger_percent = (uint8_t)((cfg.pretrigger_percent + 25U) % 100U);

  (void)LA_SetConfig(&cfg);
  redraw_requested = true;
}

void Display_HandleButton(Display_Button button)
{
  LA_Status stat;

  LA_GetStatus(&stat);
  if (button == DISPLAY_BUTTON_START_STOP)
  {
    if ((stat.state == LA_STATE_ARMED) || (stat.state == LA_STATE_TRIGGERED) ||
        (stat.state == LA_STATE_STREAMING))
      LA_Stop();
    else
      (void)LA_Start();
    redraw_requested = true;
    return;
  }
  if ((stat.state == LA_STATE_ARMED) || (stat.state == LA_STATE_TRIGGERED) ||
      (stat.state == LA_STATE_STREAMING))
    return;
  if (button == DISPLAY_BUTTON_UP)
    selected_item = (selected_item == 0U) ? 5U : (uint8_t)(selected_item - 1U);
  else if (button == DISPLAY_BUTTON_DOWN)
    selected_item = (uint8_t)((selected_item + 1U) % 6U);
  else if (button == DISPLAY_BUTTON_OK)
    ChangeSelectedSetting();
  redraw_requested = true;
}

static void ScanButtons(void)
{
  uint8_t i;
  uint32_t now = HAL_GetTick();

  for (i = 0U; i < BUTTON_COUNT; i++)
  {
    bool raw = HAL_GPIO_ReadPin(buttons[i].port, buttons[i].pin) != GPIO_PIN_RESET;
    if (raw != buttons[i].raw)
    {
      buttons[i].raw = raw;
      buttons[i].changed_at = now;
    }
    if ((raw != buttons[i].stable) && ((now - buttons[i].changed_at) >= DEBOUNCE_MS))
    {
      buttons[i].stable = raw;
      if (!raw)
        Display_HandleButton((Display_Button)i);
    }
  }
}

void Display_Init(SPI_HandleTypeDef *spi)
{
  lcd_spi = spi;
  selected_item = 0U;
  redraw_requested = true;
  last_state = LA_STATE_ERROR;
  last_config_valid = false;
  LcdResetAndConfigure();
  DrawScreen();
  redraw_requested = false;
}

void Display_Task(void)
{
  LA_Status stat;
  LA_Config cfg;

  ScanButtons();
  LA_GetStatus(&stat);
  LA_GetConfig(&cfg);
  if (stat.state != last_state)
  {
    last_state = stat.state;
    redraw_requested = true;
  }
  if (!last_config_valid || (cfg.mode != last_config.mode) ||
      (cfg.trigger != last_config.trigger) ||
      (cfg.trigger_channel != last_config.trigger_channel) ||
      (cfg.pretrigger_percent != last_config.pretrigger_percent) ||
      (cfg.sample_depth != last_config.sample_depth) ||
      (cfg.requested_rate_hz != last_config.requested_rate_hz) ||
      (cfg.actual_rate_hz != last_config.actual_rate_hz) ||
      (cfg.timeout_ms != last_config.timeout_ms))
  {
    last_config = cfg;
    last_config_valid = true;
    redraw_requested = true;
  }

  /* Khong ve SPI trong luc DMA dang lay mau de tranh lam cham LA_Task(). */
  if ((stat.state == LA_STATE_ARMED) || (stat.state == LA_STATE_TRIGGERED) ||
      (stat.state == LA_STATE_STREAMING))
  {
    return;
  }
  if (redraw_requested)
  {
    DrawScreen();
    redraw_requested = false;
  }
}
