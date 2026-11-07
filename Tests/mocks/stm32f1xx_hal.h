#ifndef STM32F1XX_HAL_H
#define STM32F1XX_HAL_H

#include <stdint.h>

typedef enum
{
  HAL_OK = 0,
  HAL_ERROR = 1
} HAL_StatusTypeDef;

typedef enum
{
  GPIO_PIN_RESET = 0,
  GPIO_PIN_SET
} GPIO_PinState;

typedef enum
{
  HAL_DMA_STATE_RESET = 0,
  HAL_DMA_STATE_READY = 1,
  HAL_DMA_STATE_BUSY = 2
} HAL_DMA_StateTypeDef;

typedef struct
{
  volatile uint32_t CR1;
  volatile uint32_t DIER;
  volatile uint32_t SR;
  volatile uint32_t EGR;
  volatile uint32_t CNT;
  volatile uint32_t PSC;
  volatile uint32_t ARR;
} TIM_TypeDef;

typedef struct
{
  volatile uint32_t IDR;
} GPIO_TypeDef;

typedef struct
{
  volatile uint32_t CFGR;
} RCC_TypeDef;

typedef struct
{
  volatile uint32_t CCR;
} DMA_Channel_TypeDef;

typedef struct
{
  volatile uint32_t SR;
} USART_TypeDef;

typedef struct
{
  USART_TypeDef *Instance;
} UART_HandleTypeDef;

typedef struct __DMA_HandleTypeDef DMA_HandleTypeDef;
struct __DMA_HandleTypeDef
{
  DMA_Channel_TypeDef *Instance;
  HAL_DMA_StateTypeDef State;
  void (*XferCpltCallback)(DMA_HandleTypeDef *dma);
  void (*XferHalfCpltCallback)(DMA_HandleTypeDef *dma);
  void (*XferErrorCallback)(DMA_HandleTypeDef *dma);
};

typedef struct
{
  uint32_t Prescaler;
  uint32_t Period;
} TIM_Base_InitTypeDef;

typedef struct
{
  TIM_TypeDef *Instance;
  TIM_Base_InitTypeDef Init;
} TIM_HandleTypeDef;

#ifdef LA_HAL_MOCK_RUNTIME
extern TIM_TypeDef mock_tim2;
extern DMA_Channel_TypeDef mock_dma1_channel2;
extern GPIO_TypeDef mock_gpioa;
extern GPIO_TypeDef mock_gpiob;
extern RCC_TypeDef mock_rcc;
#define TIM2 (&mock_tim2)
#define DMA1_Channel2 (&mock_dma1_channel2)
#define GPIOA (&mock_gpioa)
#define GPIOB (&mock_gpiob)
#define RCC (&mock_rcc)
#else
#define TIM2 ((TIM_TypeDef *)0x40000000UL)
#define DMA1_Channel2 ((DMA_Channel_TypeDef *)0x4002001CUL)
#define GPIOA ((GPIO_TypeDef *)0x40010800UL)
#define GPIOB ((GPIO_TypeDef *)0x40010C00UL)
#define RCC ((RCC_TypeDef *)0x40021000UL)
#endif
#define USART1 ((USART_TypeDef *)0x40013800UL)

#define GPIO_PIN_0  ((uint16_t)0x0001U)
#define GPIO_PIN_1  ((uint16_t)0x0002U)
#define GPIO_PIN_2  ((uint16_t)0x0004U)
#define GPIO_PIN_3  ((uint16_t)0x0008U)
#define GPIO_PIN_4  ((uint16_t)0x0010U)
#define GPIO_PIN_5  ((uint16_t)0x0020U)
#define GPIO_PIN_6  ((uint16_t)0x0040U)
#define GPIO_PIN_7  ((uint16_t)0x0080U)
#define GPIO_PIN_8  ((uint16_t)0x0100U)
#define GPIO_PIN_9  ((uint16_t)0x0200U)
#define GPIO_PIN_10 ((uint16_t)0x0400U)
#define GPIO_PIN_11 ((uint16_t)0x0800U)
#define GPIO_PIN_12 ((uint16_t)0x1000U)

#define RCC_CFGR_PPRE1 0x00000700UL
#define TIM_DMA_UPDATE 0x00000100UL
#define TIM_FLAG_UPDATE 0x00000001UL
#define TIM_EGR_UG 0x00000001UL
#define HAL_MAX_DELAY 0xFFFFFFFFUL

#define __HAL_TIM_DISABLE_DMA(handle, request) \
  ((handle)->Instance->DIER &= ~(request))
#define __HAL_TIM_ENABLE_DMA(handle, request) \
  ((handle)->Instance->DIER |= (request))
#define __HAL_TIM_DISABLE(handle) ((handle)->Instance->CR1 &= ~1UL)
#define __HAL_TIM_ENABLE(handle) ((handle)->Instance->CR1 |= 1UL)
#define __HAL_TIM_SET_PRESCALER(handle, value) \
  ((handle)->Instance->PSC = (value))
#define __HAL_TIM_SET_AUTORELOAD(handle, value) \
  ((handle)->Instance->ARR = (value))
#define __HAL_TIM_SET_COUNTER(handle, value) \
  ((handle)->Instance->CNT = (value))
#define __HAL_TIM_CLEAR_FLAG(handle, flag) \
  ((handle)->Instance->SR &= ~(flag))

uint32_t HAL_RCC_GetPCLK1Freq(void);
uint32_t HAL_GetTick(void);
GPIO_PinState HAL_GPIO_ReadPin(GPIO_TypeDef *port, uint16_t pin);
HAL_StatusTypeDef HAL_DMA_Start_IT(DMA_HandleTypeDef *dma,
                                   uint32_t source,
                                   uint32_t destination,
                                   uint32_t length);
HAL_StatusTypeDef HAL_DMA_Abort(DMA_HandleTypeDef *dma);
HAL_StatusTypeDef HAL_UART_Receive_IT(UART_HandleTypeDef *uart,
                                     uint8_t *data, uint16_t length);
HAL_StatusTypeDef HAL_UART_Transmit_IT(UART_HandleTypeDef *uart,
                                      uint8_t *data, uint16_t length);
HAL_StatusTypeDef HAL_UART_Transmit(UART_HandleTypeDef *uart,
                                   uint8_t *data, uint16_t length,
                                   uint32_t timeout);

#endif /* STM32F1XX_HAL_H */
