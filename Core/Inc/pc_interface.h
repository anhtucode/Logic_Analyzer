#ifndef PC_INTERFACE_H
#define PC_INTERFACE_H

#include <stdint.h>

void PC_Init(void);
void PC_Task(void);
void PC_USB_Receive(const uint8_t *data, uint16_t length);
void PC_SendStatus(void);

#endif
