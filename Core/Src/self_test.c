#include "self_test.h"
#include "main.h"

#define SELF_TEST_START_DELAY_MS  10U
#define SELF_TEST_REPEAT_MS       50U

#define I2C_TEST_PORT             GPIOB
#define I2C_TEST_SCL_PIN          GPIO_PIN_10
#define I2C_TEST_SDA_PIN          GPIO_PIN_11

typedef enum
{
  I2C_STEP_IDLE = 0,
  I2C_STEP_START,
  I2C_STEP_FIRST_BIT,
  I2C_STEP_CLOCK_HIGH,
  I2C_STEP_CLOCK_LOW,
  I2C_STEP_STOP_CLOCK_HIGH,
  I2C_STEP_STOP_DATA_HIGH
} I2cTest_Step;

static const uint8_t uart_message[] =
{
  0x55U, 0xAAU, 'E', 'T', 'V', 'I', 'E', 'W', '\r', '\n'
};
static const uint8_t spi_message[] = {0x55U, 0xAAU, 0xA5U, 0x5AU};
static const uint8_t i2c_message[] = {0xA0U, 0x55U, 0xAAU};

static UART_HandleTypeDef *test_uart;
static SPI_HandleTypeDef *test_spi;
static volatile SelfTest_Mode test_mode;
static volatile bool test_active;
static volatile bool transfer_active;
static volatile bool transfer_done;
static bool test_repeat;
static uint32_t next_test_tick;
static uint32_t uart_original_baud;
static uint32_t spi_original_prescaler;

static volatile I2cTest_Step i2c_step;
static volatile uint8_t i2c_byte_index;
static volatile uint8_t i2c_bit_index;

static bool TimeReached(uint32_t now, uint32_t target)
{
  return ((int32_t)(now - target) >= 0);
}

static void I2cSet(uint16_t pin, GPIO_PinState state)
{
  HAL_GPIO_WritePin(I2C_TEST_PORT, pin, state);
}

static GPIO_PinState I2cCurrentData(void)
{
  uint8_t value;

  if (i2c_bit_index >= 8U)
  {
    return GPIO_PIN_RESET; /* ACK gia lap. */
  }
  value = i2c_message[i2c_byte_index];
  return ((value & (uint8_t)(0x80U >> i2c_bit_index)) != 0U) ?
         GPIO_PIN_SET : GPIO_PIN_RESET;
}

static void FinishTransfer(void)
{
  transfer_active = false;
  transfer_done = false;
  if (test_repeat)
  {
    next_test_tick = HAL_GetTick() + SELF_TEST_REPEAT_MS;
  }
  else
  {
    test_active = false;
    test_mode = SELF_TEST_OFF;
  }
}

static bool StartUartTransfer(void)
{
  if (test_uart == NULL)
  {
    return false;
  }
  uart_original_baud = test_uart->Init.BaudRate;
  test_uart->Init.BaudRate = 9600U;
  if ((HAL_UART_Init(test_uart) != HAL_OK) ||
      (HAL_UART_Transmit_IT(test_uart, (uint8_t *)(uintptr_t)uart_message,
                            (uint16_t)sizeof(uart_message)) != HAL_OK))
  {
    test_uart->Init.BaudRate = uart_original_baud;
    (void)HAL_UART_Init(test_uart);
    return false;
  }
  transfer_active = true;
  return true;
}

static void RestoreUart(void)
{
  if (test_uart != NULL)
  {
    test_uart->Init.BaudRate = uart_original_baud;
    (void)HAL_UART_Init(test_uart);
  }
}

static bool StartI2cTransfer(void)
{
  i2c_byte_index = 0U;
  i2c_bit_index = 0U;
  i2c_step = I2C_STEP_START;
  transfer_done = false;
  transfer_active = true;
  I2cSet(I2C_TEST_SCL_PIN, GPIO_PIN_SET);
  I2cSet(I2C_TEST_SDA_PIN, GPIO_PIN_SET);
  return true;
}

static bool StartSpiTransfer(void)
{
  if (test_spi == NULL)
  {
    return false;
  }

  /* APB1=36 MHz: prescaler 256 tao SCK khoang 140.625 kHz. */
  spi_original_prescaler = test_spi->Init.BaudRatePrescaler;
  test_spi->Init.BaudRatePrescaler = SPI_BAUDRATEPRESCALER_256;
  if ((HAL_SPI_Init(test_spi) != HAL_OK) ||
      (HAL_SPI_Transmit_IT(test_spi, (uint8_t *)(uintptr_t)spi_message,
                           (uint16_t)sizeof(spi_message)) != HAL_OK))
  {
    test_spi->Init.BaudRatePrescaler = spi_original_prescaler;
    (void)HAL_SPI_Init(test_spi);
    return false;
  }
  transfer_active = true;
  return true;
}

static void RestoreSpi(void)
{
  if (test_spi != NULL)
  {
    test_spi->Init.BaudRatePrescaler = spi_original_prescaler;
    (void)HAL_SPI_Init(test_spi);
  }
}

void SelfTest_Init(UART_HandleTypeDef *uart, SPI_HandleTypeDef *spi)
{
  test_uart = uart;
  test_spi = spi;
  test_mode = SELF_TEST_OFF;
  test_active = false;
  transfer_active = false;
  transfer_done = false;
  test_repeat = false;
  next_test_tick = 0U;
  i2c_step = I2C_STEP_IDLE;

  /* CubeMX chua bat SPI2 IRQ; self-test IT can IRQ nay o priority thap hon DMA. */
  HAL_NVIC_SetPriority(SPI2_IRQn, 2U, 0U);
  HAL_NVIC_EnableIRQ(SPI2_IRQn);
}

bool SelfTest_Start(SelfTest_Mode mode, bool repeat)
{
  if ((mode < SELF_TEST_UART) || (mode > SELF_TEST_SPI) || test_active)
  {
    return false;
  }
  if (((mode == SELF_TEST_UART) && (test_uart == NULL)) ||
      ((mode == SELF_TEST_SPI) && (test_spi == NULL)))
  {
    return false;
  }

  test_mode = mode;
  test_repeat = repeat;
  test_active = true;
  transfer_active = false;
  transfer_done = false;
  next_test_tick = HAL_GetTick() + SELF_TEST_START_DELAY_MS;
  return true;
}

void SelfTest_Stop(void)
{
  SelfTest_Mode previous_mode = test_mode;

  test_active = false;
  test_repeat = false;
  transfer_done = false;
  i2c_step = I2C_STEP_IDLE;

  if ((previous_mode == SELF_TEST_UART) && transfer_active && (test_uart != NULL))
  {
    (void)HAL_UART_AbortTransmit(test_uart);
    RestoreUart();
  }
  else if ((previous_mode == SELF_TEST_SPI) && transfer_active && (test_spi != NULL))
  {
    (void)HAL_SPI_Abort(test_spi);
    RestoreSpi();
  }
  else if (previous_mode == SELF_TEST_I2C)
  {
    I2cSet(I2C_TEST_SCL_PIN, GPIO_PIN_SET);
    I2cSet(I2C_TEST_SDA_PIN, GPIO_PIN_SET);
  }

  transfer_active = false;
  test_mode = SELF_TEST_OFF;
}

void SelfTest_Task(void)
{
  bool started = false;

  if (!test_active)
  {
    return;
  }

  if (transfer_active)
  {
    if ((test_mode == SELF_TEST_UART) && (test_uart->gState == HAL_UART_STATE_READY))
    {
      RestoreUart();
      FinishTransfer();
    }
    else if ((test_mode == SELF_TEST_SPI) && (test_spi->State == HAL_SPI_STATE_READY))
    {
      RestoreSpi();
      FinishTransfer();
    }
    else if ((test_mode == SELF_TEST_I2C) && transfer_done)
    {
      FinishTransfer();
    }
    return;
  }

  if (!TimeReached(HAL_GetTick(), next_test_tick))
  {
    return;
  }

  switch (test_mode)
  {
    case SELF_TEST_UART:
      started = StartUartTransfer();
      break;
    case SELF_TEST_I2C:
      started = StartI2cTransfer();
      break;
    case SELF_TEST_SPI:
      started = StartSpiTransfer();
      break;
    default:
      SelfTest_Stop();
      return;
  }

  if (!started)
  {
    /* Peripheral dang ban: thu lai ma khong block main loop. */
    next_test_tick = HAL_GetTick() + 1U;
  }
}

void SelfTest_Tick1ms(void)
{
  if (!test_active || !transfer_active || (test_mode != SELF_TEST_I2C))
  {
    return;
  }

  switch (i2c_step)
  {
    case I2C_STEP_START:
      /* START: SDA 1->0 trong khi SCL dang 1. */
      I2cSet(I2C_TEST_SDA_PIN, GPIO_PIN_RESET);
      i2c_step = I2C_STEP_FIRST_BIT;
      break;

    case I2C_STEP_FIRST_BIT:
      I2cSet(I2C_TEST_SCL_PIN, GPIO_PIN_RESET);
      I2cSet(I2C_TEST_SDA_PIN, I2cCurrentData());
      i2c_step = I2C_STEP_CLOCK_HIGH;
      break;

    case I2C_STEP_CLOCK_HIGH:
      I2cSet(I2C_TEST_SCL_PIN, GPIO_PIN_SET);
      i2c_step = I2C_STEP_CLOCK_LOW;
      break;

    case I2C_STEP_CLOCK_LOW:
      I2cSet(I2C_TEST_SCL_PIN, GPIO_PIN_RESET);
      i2c_bit_index++;
      if (i2c_bit_index >= 9U)
      {
        i2c_bit_index = 0U;
        i2c_byte_index++;
      }
      if (i2c_byte_index >= (uint8_t)sizeof(i2c_message))
      {
        I2cSet(I2C_TEST_SDA_PIN, GPIO_PIN_RESET);
        i2c_step = I2C_STEP_STOP_CLOCK_HIGH;
      }
      else
      {
        I2cSet(I2C_TEST_SDA_PIN, I2cCurrentData());
        i2c_step = I2C_STEP_CLOCK_HIGH;
      }
      break;

    case I2C_STEP_STOP_CLOCK_HIGH:
      I2cSet(I2C_TEST_SCL_PIN, GPIO_PIN_SET);
      i2c_step = I2C_STEP_STOP_DATA_HIGH;
      break;

    case I2C_STEP_STOP_DATA_HIGH:
      I2cSet(I2C_TEST_SDA_PIN, GPIO_PIN_SET);
      i2c_step = I2C_STEP_IDLE;
      transfer_done = true;
      break;

    default:
      break;
  }
}

bool SelfTest_IsActive(void)
{
  return test_active;
}
