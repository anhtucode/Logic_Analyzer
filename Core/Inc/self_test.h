#ifndef SELF_TEST_H
#define SELF_TEST_H

#include "stm32f1xx_hal.h"
#include <stdbool.h>
#include <stdint.h>

typedef enum
{
  SELF_TEST_OFF = 0,
  SELF_TEST_UART = 1,
  SELF_TEST_I2C = 2,
  SELF_TEST_SPI = 3
} SelfTest_Mode;

/*
 * Bo phat tin hieu mau dung chinh cac peripheral/GPIO da co trong CubeMX.
 * Self-test mac dinh OFF va chi chay khi PC gui lenh RUN_SELF_TEST.
 */
void SelfTest_Init(UART_HandleTypeDef *uart, SPI_HandleTypeDef *spi);
bool SelfTest_Start(SelfTest_Mode mode, bool repeat);
void SelfTest_Stop(void);
void SelfTest_Task(void);
void SelfTest_Tick1ms(void);
bool SelfTest_IsActive(void);

#endif
