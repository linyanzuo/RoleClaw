---
name: test-rules-baseline
description: 测试工程通用规范基线：用例独立性、可重复性、可追溯性
globs: "**/*.spec.{ts,js,py}"
alwaysApply: false
---

# 测试规范基线

## 用例独立性

- 单用例不依赖其他用例执行结果
- 可单独运行、可重复执行

## 可追溯性

- 用例与需求/PRD 可关联
- 失败时便于定位问题

## 可维护性

- 测试数据与逻辑分离
- 公共 setup/teardown 抽取
