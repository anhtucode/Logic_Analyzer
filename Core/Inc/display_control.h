#ifndef DISPLAY_CONTROL_H
#define DISPLAY_CONTROL_H

#include "stm32f1xx_hal.h"
#include <stdint.h>

typedef enum
{
  DISPLAY_BUTTON_UP = 0,
  DISPLAY_BUTTON_DOWN,
  DISPLAY_BUTTON_OK,
  DISPLAY_BUTTON_BACK,
  DISPLAY_BUTTON_START_STOP
} Display_Button;

void Display_Init(SPI_HandleTypeDef *spi);
void Display_Task(void);
void Display_DrawWaveform(void);
void Display_HandleButton(Display_Button button);

#endif
