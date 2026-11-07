#include <assert.h>
#include <stdint.h>

#define LA_HAL_MOCK_RUNTIME
#include "stm32f1xx_hal.h"
#include "buttons.h"

TIM_TypeDef mock_tim2;
DMA_Channel_TypeDef mock_dma1_channel2;
GPIO_TypeDef mock_gpioa;
GPIO_TypeDef mock_gpiob;
RCC_TypeDef mock_rcc;

static uint32_t mock_tick;

uint32_t HAL_GetTick(void)
{
  return mock_tick;
}

GPIO_PinState HAL_GPIO_ReadPin(GPIO_TypeDef *port, uint16_t pin)
{
  return ((port->IDR & pin) != 0U) ? GPIO_PIN_SET : GPIO_PIN_RESET;
}

static void AdvanceScans(uint8_t scan_count)
{
  uint8_t index;
  for (index = 0U; index < scan_count; index++)
  {
    mock_tick += 5U;
    Buttons_Process();
  }
}

int main(void)
{
  button_event_t event;

  mock_gpiob.IDR = GPIO_PIN_5 | GPIO_PIN_6 | GPIO_PIN_7 |
                   GPIO_PIN_8 | GPIO_PIN_9;
  mock_tick = 0U;
  Buttons_Init();
  assert(!Buttons_GetEvent(&event));

  /* A short bounce does not produce an event. */
  mock_gpiob.IDR &= ~GPIO_PIN_5;
  AdvanceScans(2U);
  mock_gpiob.IDR |= GPIO_PIN_5;
  AdvanceScans(4U);
  assert(!Buttons_GetEvent(&event));

  /* A stable active-low press produces exactly one event after 20 ms. */
  mock_gpiob.IDR &= ~GPIO_PIN_5;
  AdvanceScans(4U);
  assert(Buttons_GetEvent(&event));
  assert(event == BUTTON_EVENT_UP);
  assert(!Buttons_GetEvent(&event));
  AdvanceScans(10U);
  assert(!Buttons_GetEvent(&event));

  /* Release and press another key. */
  mock_gpiob.IDR |= GPIO_PIN_5;
  AdvanceScans(4U);
  mock_gpiob.IDR &= ~GPIO_PIN_9;
  AdvanceScans(4U);
  assert(Buttons_GetEvent(&event));
  assert(event == BUTTON_EVENT_ARM_STOP);
  assert(!Buttons_GetEvent(&event));

  return 0;
}
