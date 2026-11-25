/* Mo phong GRAM landscape tren PC; khong xac nhan huong scan cua board that. */
#include "lcd_mode.h"
#include "acquisition.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static LCD_Stream workspace;
static uint16_t gram[240][320];
static bool selected, data_mode, sleep_out, display_on, scroll_defined;
static uint8_t command, color_mask;
static uint16_t x0, x1, y0, y1, cx, cy, pressed_pins;
static uint16_t scroll_address = 64U, committed_left;
static uint32_t tick, init_count, start_count, commits, wraps;
static uint32_t plot_pixels, sidebar_pixels;
static bool verify_image, fail_plot;
static LA_Status mock_status;

LCD_Stream *LA_LcdWorkspace(void) { return &workspace; }
uint32_t HAL_GetTick(void) { return tick; }
void HAL_Delay(uint32_t delay) { tick += delay; }
GPIO_PinState HAL_GPIO_ReadPin(GPIO_TypeDef *port, uint16_t pins)
{ (void)port; return (pressed_pins & pins) ? GPIO_PIN_RESET : GPIO_PIN_SET; }
void HAL_GPIO_WritePin(GPIO_TypeDef *port, uint16_t pins, GPIO_PinState state)
{
  (void)port;
  if (pins & GPIO_PIN_12) selected = state == GPIO_PIN_RESET;
  if (pins & GPIO_PIN_10) data_mode = state == GPIO_PIN_SET;
}
void LA_GetStatus(LA_Status *status) { *status = mock_status; }
void LA_Stop(void) { mock_status.state = LA_STATE_IDLE; }
bool LA_StartLcdPlayback(void)
{ start_count++; mock_status.state = LA_STATE_STREAMING; return true; }
HAL_StatusTypeDef HAL_SPI_Init(SPI_HandleTypeDef *spi)
{
  assert(spi->Init.BaudRatePrescaler == (init_count % 2U == 0U ?
         SPI_BAUDRATEPRESCALER_16 : SPI_BAUDRATEPRESCALER_2));
  init_count++;
  return HAL_OK;
}

static void ReferenceMasks(uint16_t k, uint8_t *low, uint8_t *high)
{
  uint32_t i;
  uint32_t a = ((uint32_t)k * 1000U + 255U) / 256U;
  uint32_t b = ((uint32_t)(k + 1U) * 1000U + 255U) / 256U;
  *low = *high = 0;
  assert(b <= workspace.recorded_samples);
  for (i = a; i < b; i++)
  { *low |= (uint8_t)~workspace.recording[i]; *high |= workspace.recording[i]; }
}

static void VerifyVisible(void)
{
  uint16_t x, y;
  for (x = 0; x < 256; x++)
  {
    uint16_t k = (uint16_t)(committed_left + x);
    uint16_t physical = (uint16_t)(64U + (scroll_address - 64U + x) % 256U);
    uint8_t low, high, pl = 0, ph = 0, edges;
    ReferenceMasks(k, &low, &high);
    if (k) ReferenceMasks((uint16_t)(k - 1U), &pl, &ph);
    edges = (uint8_t)((low & high) | (pl & (uint8_t)~ph & high & (uint8_t)~low) |
                      (ph & (uint8_t)~pl & low & (uint8_t)~high));
    for (y = 0; y < 240; y++)
    {
      uint8_t lane = (uint8_t)(y / 30U), row = (uint8_t)(y % 30U);
      uint8_t mask = (uint8_t)(1U << lane);
      uint16_t expected = ((row == 7U && (high & mask)) ||
                           (row == 22U && (low & mask)) ||
                           (row >= 7U && row <= 22U && (edges & mask))) ?
                          ((lane & 1U) ? 0xFD20U : 0x07FFU) :
                          ((row == 15U || k % 64U == 0U) ? 0x2945U : 0U);
      assert(gram[y][physical] == expected);
    }
  }
}

HAL_StatusTypeDef HAL_SPI_Transmit(SPI_HandleTypeDef *spi, const uint8_t *bytes,
                                 uint16_t length, uint32_t timeout)
{
  (void)spi; (void)timeout;
  assert(selected);
  if (!data_mode)
  {
    assert(length == 1);
    command = bytes[0];
    assert(command != 0x28); /* Khong blank man hinh de cuon. */
    if (command == 0x11) sleep_out = true;
    if (command == 0x29) { assert(sleep_out); display_on = true; }
    if (command == 0x2C) { cx = x0; cy = y0; }
    return HAL_OK;
  }
  if (command == 0x33)
  {
    static const uint8_t expected[] = {0,64,1,0,0,0};
    assert(length == 6 && memcmp(bytes, expected, 6) == 0);
    scroll_defined = true;
  }
  else if (command == 0x37)
  {
    uint16_t address = (uint16_t)((bytes[0] << 8) | bytes[1]);
    assert(scroll_defined && length == 2 && address >= 64 && address < 320);
    if (verify_image && plot_pixels)
    {
      if (plot_pixels == 256U * 240U)
      {
        assert(address == 64);
        committed_left = 0;
      }
      else
      {
        uint16_t delta = (uint16_t)((address + 256U - scroll_address) % 256U);
        assert(delta >= 1 && delta <= 3);
        assert(plot_pixels == (uint32_t)delta * 240U); /* all columns before pointer */
        committed_left += delta;
        if (address < scroll_address) wraps++;
      }
      scroll_address = address;
      VerifyVisible(); /* All 8 lanes correct, including after RAM wraps. */
      commits++;
    }
    else { scroll_address = address; assert(plot_pixels == 0); }
    plot_pixels = 0;
  }
  else if (command == 0x2A || command == 0x2B)
  {
    uint16_t a = (uint16_t)((bytes[0] << 8) | bytes[1]);
    uint16_t b = (uint16_t)((bytes[2] << 8) | bytes[3]);
    assert(length == 4 && a <= b);
    if (command == 0x2A) { x0 = a; x1 = b; assert(b < 320); }
    else { y0 = a; y1 = b; assert(b < 240); }
  }
  else if (command == 0x2C)
  {
    uint16_t p;
    assert(display_on && length % 2U == 0);
    if (verify_image)
    {
      if (x0 >= 64U)
      {
        assert(x0 == x1 && y1 - y0 + 1U == length / 2U);
        if (fail_plot) return HAL_ERROR;
      }
      else assert(x0 == 2 && x1 == 43); /* Metadata before channel labels x=48. */
    }
    for (p = 0; p < length / 2U; p++)
    {
      uint16_t color = (uint16_t)((bytes[2U*p] << 8) | bytes[2U*p + 1U]);
      assert(cx <= x1 && cy <= y1);
      gram[cy][cx] = color;
      if (verify_image)
      {
        if (cx >= 64) plot_pixels++;
        else sidebar_pixels++;
      }
      if (color == 0xF800) color_mask |= 1;
      if (color == 0x07E0) color_mask |= 2;
      if (color == 0x001F) color_mask |= 4;
      if (++cx > x1) { cx = x0; cy++; }
    }
  }
  else if (command == 0xCB)
  {
    static const uint8_t expected[] = {0x39,0x2C,0,0x34,2};
    assert(length == 5 && memcmp(bytes, expected, 5) == 0);
  }
  else if (command == 0xEA) assert(length == 2);
  return HAL_OK;
}

static void Drain(uint16_t calls)
{ while (calls--) Display_Task(); }

static void Press(uint16_t pin)
{
  pressed_pins = pin;
  Display_Task(); tick += 21; Display_Task();
  pressed_pins = 0;
  Display_Task(); tick += 21; Display_Task();
}

static void CompleteRecording(void)
{
  static const uint16_t periods[8] = {50,100,125,250,500,64,200,80};
  uint16_t i;
  uint8_t lane;
  for (i = 0; i < 4096; i++)
  {
    uint8_t sample = 0;
    for (lane = 0; lane < 8; lane++)
      if (i % periods[lane] < periods[lane] / 2U) sample |= (uint8_t)(1U << lane);
    workspace.recording[i] = sample;
  }
  workspace.recorded_samples = 4096;
  mock_status.state = LA_STATE_COMPLETE;
}

int main(void)
{
  SPI_HandleTypeDef spi = {0};
  uint32_t before;
  uint16_t i;
  spi.Init.BaudRatePrescaler = SPI_BAUDRATEPRESCALER_2;
  Display_Init(&spi);
  assert(init_count == 2 && color_mask == 7 && scroll_defined && scroll_address == 64);
  assert(workspace.recorded_samples == 0);
  verify_image = true;
  Drain(150);
  Press(GPIO_PIN_6);
  assert(start_count == 1 && mock_status.state == LA_STATE_STREAMING);
  CompleteRecording();
  Drain(1200);
  assert(commits == 1 && workspace.playback_offset == 0 && plot_pixels == 0);
  before = commits;
  tick += 99; Drain(1);
  assert(commits == before);
  tick += 1; Drain(20);
  assert(commits == before + 1 && committed_left == 3 && plot_pixels == 0);
  Press(GPIO_PIN_6); /* Khong thu lai khi PLAY dang chay. */
  assert(start_count == 1);

  /* Stop trong luc cot dang ghi: phai ghi du dai hep roi moi HOLD. */
  tick += 100; Drain(1);
  assert(plot_pixels == 64);
  Press(GPIO_PIN_7);
  Drain(30);
  assert(committed_left == 6 && plot_pixels == 0);
  before = commits;
  tick += 1000; Drain(150);
  assert(commits == before);

  Press(GPIO_PIN_6);
  assert(start_count == 2 && workspace.recorded_samples == 0 && scroll_address == 64);
  CompleteRecording(); Drain(1200);
  for (i = 0; i < 270; i++) { tick += 100; Drain(150); }
  assert(committed_left == 792 && wraps >= 3 && workspace.playback_offset == 3094);
  before = commits;
  tick += 1000; Drain(150);
  assert(commits == before && plot_pixels == 0); /* end HOLD, no false wrap */
  assert(sidebar_pixels > 0);
  Press(GPIO_PIN_6 | GPIO_PIN_7); /* Stop uu tien, khong start khi hai nut cung nhan. */
  assert(start_count == 2 && commits == before);

  /* Loi SPI sau khi da ghi mot phan: khong duoc gui pointer moi. */
  Press(GPIO_PIN_6);
  CompleteRecording(); Drain(1200);
  tick += 100; Drain(1);
  assert(plot_pixels == 64);
  before = commits;
  fail_plot = true;
  Drain(40);
  assert(commits == before && scroll_address == 64 && mock_status.state == LA_STATE_IDLE);
  puts("LCD hardware scroll: GRAM reference, 8 lanes, 3 wraps, sidebar, Stop and SPI error PASS");
  return 0;
}
