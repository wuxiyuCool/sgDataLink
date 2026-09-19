# RESTful API Node Server Boilerplate

[![Build Status](https://travis-ci.org/hagopj13/node-express-boilerplate.svg?branch=master)](https://travis-ci.org/hagopj13/node-express-boilerplate)
[![Coverage Status](https://coveralls.io/repos/github/hagopj13/node-express-boilerplate/badge.svg?branch=master)](https://coveralls.io/github/hagopj13/node-express-boilerplate?branch=master)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](http://makeapullrequest.com)

A boilerplate/starter project for quickly building RESTful APIs using Node.js, Express, and Mongoose.

By running a single command, you will get a production-ready Node.js app installed and fully configured on your machine. The app comes with many built-in features, such as authentication using JWT, request validation, unit and integration tests, continuous integration, docker support, API documentation, pagination, etc. For more details, check the features list below.

## Quick Start

To create a project, simply run:

```bash
npx create-nodejs-express-app <project-name>
```

Or

```bash
npm init nodejs-express-app <project-name>
```

## Manual Installation

If you would still prefer to do the installation manually, follow these steps:

Clone the repo:

```bash
git clone --depth 1 https://github.com/hagopj13/node-express-boilerplate.git
cd node-express-boilerplate
npx rimraf ./.git
```

Install the dependencies:

```bash
yarn install
```

Set the environment variables:

```bash
cp .env.example .env

# open .env and modify the environment variables (if needed)
```

## Table of Contents

- [Features](#features)
- [Commands](#commands)
- [Environment Variables](#environment-variables)
- [Project Structure](#project-structure)
- [API Documentation](#api-documentation)
- [Error Handling](#error-handling)
- [Validation](#validation)
- [Authentication](#authentication)
- [Authorization](#authorization)
- [Logging](#logging)
- [Custom Mongoose Plugins](#custom-mongoose-plugins)
- [Linting](#linting)
- [Contributing](#contributing)

## Features

- **NoSQL database**: [MongoDB](https://www.mongodb.com) object data modeling using [Mongoose](https://mongoosejs.com)
- **Authentication and authorization**: using [passport](http://www.passportjs.org)
- **Validation**: request data validation using [Joi](https://github.com/hapijs/joi)
- **Logging**: using [winston](https://github.com/winstonjs/winston) and [morgan](https://github.com/expressjs/morgan)
- **Testing**: unit and integration tests using [Jest](https://jestjs.io)
- **Error handling**: centralized error handling mechanism
- **API documentation**: with [swagger-jsdoc](https://github.com/Surnet/swagger-jsdoc) and [swagger-ui-express](https://github.com/scottie1984/swagger-ui-express)
- **Process management**: advanced production process management using [PM2](https://pm2.keymetrics.io)
- **Dependency management**: with [Yarn](https://yarnpkg.com)
- **Environment variables**: using [dotenv](https://github.com/motdotla/dotenv) and [cross-env](https://github.com/kentcdodds/cross-env#readme)
- **Security**: set security HTTP headers using [helmet](https://helmetjs.github.io)
- **Santizing**: sanitize request data against xss and query injection
- **CORS**: Cross-Origin Resource-Sharing enabled using [cors](https://github.com/expressjs/cors)
- **Compression**: gzip compression with [compression](https://github.com/expressjs/compression)
- **CI**: continuous integration with [Travis CI](https://travis-ci.org)
- **Docker support**
- **Code coverage**: using [coveralls](https://coveralls.io)
- **Code quality**: with [Codacy](https://www.codacy.com)
- **Git hooks**: with [husky](https://github.com/typicode/husky) and [lint-staged](https://github.com/okonet/lint-staged)
- **Linting**: with [ESLint](https://eslint.org) and [Prettier](https://prettier.io)
- **Editor config**: consistent editor configuration using [EditorConfig](https://editorconfig.org)

## Commands

Running locally:

```bash
yarn dev
```

Running in production:

```bash
yarn start
```

Testing:

```bash
# run all tests
yarn test

# run all tests in watch mode
yarn test:watch

# run test coverage
yarn coverage
```

Docker:

```bash
# run docker container in development mode
yarn docker:dev

# run docker container in production mode
yarn docker:prod

# run all tests in a docker container
yarn docker:test
```

Linting:

```bash
# run ESLint
yarn lint

# fix ESLint errors
yarn lint:fix

# run prettier
yarn prettier

# fix prettier errors
yarn prettier:fix
```

## Environment Variables

The environment variables can be found and modified in the `.env` file. They come with these default values:

```bash
# Port number
PORT=3000

# URL of the Mongo DB
MONGODB_URL=mongodb://127.0.0.1:27017/node-boilerplate

# JWT
# JWT secret key
JWT_SECRET=thisisasamplesecret
# Number of minutes after which an access token expires
JWT_ACCESS_EXPIRATION_MINUTES=30
# Number of days after which a refresh token expires
JWT_REFRESH_EXPIRATION_DAYS=30

# SMTP configuration options for the email service
# For testing, you can use a fake SMTP service like Ethereal: https://ethereal.email/create
SMTP_HOST=email-server
SMTP_PORT=587
SMTP_USERNAME=email-server-username
SMTP_PASSWORD=email-server-password
EMAIL_FROM=support@yourapp.com
```

## Project Structure

```
src\
 |--config\         # Environment variables and configuration related things
 |--controllers\    # Route controllers (controller layer)
 |--docs\           # Swagger files
 |--middlewares\    # Custom express middlewares
 |--models\         # Mongoose models (data layer)
 |--routes\         # Routes
 |--services\       # Business logic (service layer)
 |--utils\          # Utility classes and functions
 |--validations\    # Request data validation schemas
 |--app.js          # Express app
 |--index.js        # App entry point
```

## API Documentation

To view the list of available APIs and their specifications, run the server and go to `http://localhost:3000/v1/docs` in your browser. This documentation page is automatically generated using the [swagger](https://swagger.io/) definitions written as comments in the route files.

### API Endpoints

List of available routes:

**Auth routes**:\
`POST /v1/auth/register` - register\
`POST /v1/auth/login` - login\
`POST /v1/auth/refresh-tokens` - refresh auth tokens\
`POST /v1/auth/forgot-password` - send reset password email\
`POST /v1/auth/reset-password` - reset password\
`POST /v1/auth/send-verification-email` - send verification email\
`POST /v1/auth/verify-email` - verify email

**User routes**:\
`POST /v1/users` - create a user\
`GET /v1/users` - get all users\
`GET /v1/users/:userId` - get user\
`PATCH /v1/users/:userId` - update user\
`DELETE /v1/users/:userId` - delete user

## Error Handling

The app has a centralized error handling mechanism.

Controllers should try to catch the errors and forward them to the error handling middleware (by calling `next(error)`). For convenience, you can also wrap the controller inside the catchAsync utility wrapper, which forwards the error.

```javascript
const catchAsync = require('../utils/catchAsync');

const controller = catchAsync(async (req, res) => {
  // this error will be forwarded to the error handling middleware
  throw new Error('Something wrong happened');
});
```

The error handling middleware sends an error response, which has the following format:

```json
{
  "code": 404,
  "message": "Not found"
}
```

When running in development mode, the error response also contains the error stack.

The app has a utility ApiError class to which you can attach a response code and a message, and then throw it from anywhere (catchAsync will catch it).

For example, if you are trying to get a user from the DB who is not found, and you want to send a 404 error, the code should look something like:

```javascript
const httpStatus = require('http-status');
const ApiError = require('../utils/ApiError');
const User = require('../models/User');

const getUser = async (userId) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }
};
```

## Validation

Request data is validated using [Joi](https://joi.dev/). Check the [documentation](https://joi.dev/api/) for more details on how to write Joi validation schemas.

The validation schemas are defined in the `src/validations` directory and are used in the routes by providing them as parameters to the `validate` middleware.

```javascript
const express = require('express');
const validate = require('../../middlewares/validate');
const userValidation = require('../../validations/user.validation');
const userController = require('../../controllers/user.controller');

const router = express.Router();

router.post('/users', validate(userValidation.createUser), userController.createUser);
```

## Authentication

To require authentication for certain routes, you can use the `auth` middleware.

```javascript
const express = require('express');
const auth = require('../../middlewares/auth');
const userController = require('../../controllers/user.controller');

const router = express.Router();

router.post('/users', auth(), userController.createUser);
```

These routes require a valid JWT access token in the Authorization request header using the Bearer schema. If the request does not contain a valid access token, an Unauthorized (401) error is thrown.

**Generating Access Tokens**:

An access token can be generated by making a successful call to the register (`POST /v1/auth/register`) or login (`POST /v1/auth/login`) endpoints. The response of these endpoints also contains refresh tokens (explained below).

An access token is valid for 30 minutes. You can modify this expiration time by changing the `JWT_ACCESS_EXPIRATION_MINUTES` environment variable in the .env file.

**Refreshing Access Tokens**:

After the access token expires, a new access token can be generated, by making a call to the refresh token endpoint (`POST /v1/auth/refresh-tokens`) and sending along a valid refresh token in the request body. This call returns a new access token and a new refresh token.

A refresh token is valid for 30 days. You can modify this expiration time by changing the `JWT_REFRESH_EXPIRATION_DAYS` environment variable in the .env file.

## Authorization

The `auth` middleware can also be used to require certain rights/permissions to access a route.

```javascript
const express = require('express');
const auth = require('../../middlewares/auth');
const userController = require('../../controllers/user.controller');

const router = express.Router();

router.post('/users', auth('manageUsers'), userController.createUser);
```

In the example above, an authenticated user can access this route only if that user has the `manageUsers` permission.

The permissions are role-based. You can view the permissions/rights of each role in the `src/config/roles.js` file.

If the user making the request does not have the required permissions to access this route, a Forbidden (403) error is thrown.

## Logging

Import the logger from `src/config/logger.js`. It is using the [Winston](https://github.com/winstonjs/winston) logging library.

Logging should be done according to the following severity levels (ascending order from most important to least important):

```javascript
const logger = require('<path to src>/config/logger');

logger.error('message'); // level 0
logger.warn('message'); // level 1
logger.info('message'); // level 2
logger.http('message'); // level 3
logger.verbose('message'); // level 4
logger.debug('message'); // level 5
```

In development mode, log messages of all severity levels will be printed to the console.

In production mode, only `info`, `warn`, and `error` logs will be printed to the console.\
It is up to the server (or process manager) to actually read them from the console and store them in log files.\
This app uses pm2 in production mode, which is already configured to store the logs in log files.

Note: API request information (request url, response code, timestamp, etc.) are also automatically logged (using [morgan](https://github.com/expressjs/morgan)).

## Custom Mongoose Plugins

The app also contains 2 custom mongoose plugins that you can attach to any mongoose model schema. You can find the plugins in `src/models/plugins`.

```javascript
const mongoose = require('mongoose');
const { toJSON, paginate } = require('./plugins');

const userSchema = mongoose.Schema(
  {
    /* schema definition here */
  },
  { timestamps: true }
);

userSchema.plugin(toJSON);
userSchema.plugin(paginate);

const User = mongoose.model('User', userSchema);
```

### toJSON

The toJSON plugin applies the following changes in the toJSON transform call:

- removes \_\_v, createdAt, updatedAt, and any schema path that has private: true
- replaces \_id with id

### paginate

The paginate plugin adds the `paginate` static method to the mongoose schema.

Adding this plugin to the `User` model schema will allow you to do the following:

```javascript
const queryUsers = async (filter, options) => {
  const users = await User.paginate(filter, options);
  return users;
};
```

The `filter` param is a regular mongo filter.

The `options` param can have the following (optional) fields:

```javascript
const options = {
  sortBy: 'name:desc', // sort order
  limit: 5, // maximum results per page
  page: 2, // page number
};
```

The plugin also supports sorting by multiple criteria (separated by a comma): `sortBy: name:desc,role:asc`

The `paginate` method returns a Promise, which fulfills with an object having the following properties:

```json
{
  "results": [],
  "page": 2,
  "limit": 5,
  "totalPages": 10,
  "totalResults": 48
}
```

## Linting

Linting is done using [ESLint](https://eslint.org/) and [Prettier](https://prettier.io).

In this app, ESLint is configured to follow the [Airbnb JavaScript style guide](https://github.com/airbnb/javascript/tree/master/packages/eslint-config-airbnb-base) with some modifications. It also extends [eslint-config-prettier](https://github.com/prettier/eslint-config-prettier) to turn off all rules that are unnecessary or might conflict with Prettier.

To modify the ESLint configuration, update the `.eslintrc.json` file. To modify the Prettier configuration, update the `.prettierrc.json` file.

To prevent a certain file or directory from being linted, add it to `.eslintignore` and `.prettierignore`.

To maintain a consistent coding style across different IDEs, the project contains `.editorconfig`

## Contributing

Contributions are more than welcome! Please check out the [contributing guide](CONTRIBUTING.md).

## Inspirations

- [danielfsousa/express-rest-es2017-boilerplate](https://github.com/danielfsousa/express-rest-es2017-boilerplate)
- [madhums/node-express-mongoose](https://github.com/madhums/node-express-mongoose)
- [kunalkapadia/express-mongoose-es6-rest-api](https://github.com/kunalkapadia/express-mongoose-es6-rest-api)

## License

[MIT](LICENSE)

## DataBridge Mock 模式启动

本仓库在 hagopj13 脚手架内扩展了 DataBridge 管理后端（`docs/API.md` 第 1 节）。
Mock 阶段**不连接任何数据库**：数据全部放在 `src/repositories/` 的内存仓储里，
进程重启即回到种子状态。接口前缀 `/api/v1`，默认端口 `3001`。

### 1. 前置 .env 变量清单

在项目根目录创建 `.env`（可从 `.env.example` 复制），`yarn dev` 之前需要确认：

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `NODE_ENV` | 是 | 无 | `development` / `production` / `test`，config 校验必填 |
| `PORT` | 否 | `3001` | 管理后端监听端口（契约默认 3001） |
| `MEM_MOCK` | 否 | `true` | `true` 时跳过 mongoose.connect，直接 listen 并注入种子数据（`MOCK=true` 同义） |
| `ENGINE_BASE_URL` | 否 | `http://127.0.0.1:8080` | Go 同步引擎地址，start/stop 指令下发前缀 |
| `ADMIN_REPORT_URL` | 否 | `http://127.0.0.1:3001/api/v1/engine` | 引擎回报进度的地址（容器里写服务名，如 `http://databridge-admin:3001/api/v1/engine`） |
| `ENGINE_TIMEOUT_MS` | 否 | `5000` | 调用引擎的超时 |
| `MONGODB_URL` | 否 | `''` | **MEM_MOCK=true 时留空**；只有 `MEM_MOCK=false` 走原 MongoDB 模式才需要 |
| `JWT_SECRET` | 否 | `databridge-mock-secret` | DataBridge 新路由 Mock 阶段不鉴权，仅脚手架自带 `/auth` `/users` 需要 |
| `JWT_*`、`SMTP_*`、`EMAIL_FROM` | 否 | 见 config | 脚手架原有变量，mock 模式用不到 |

### 2. 依赖清单（本仓库不代你执行安装命令）

运行 `yarn dev` 前 `node_modules` 需已具备（Node **>= 18**，`engineClient` 使用全局 `fetch`）：

- 运行时：`express`、`joi`、`http-status`、`winston`、`morgan`、`helmet`、`cors`、`compression`、
  `dotenv`、`passport`、`passport-jwt`、`jsonwebtoken`、`mongoose`、`express-mongo-sanitize`、
  `express-rate-limit`、`xss-clean`、`bcryptjs`、`nodemailer`、`moment`、`validator`、
  `swagger-jsdoc`、`swagger-ui-express`、`cross-env`、`pm2`
- 开发期：`nodemon`（`yarn dev` 需要）、`eslint`、`prettier`、`jest`、`supertest`、`node-mocks-http`、`faker`

新增的 DataBridge 代码本身**不引入任何新的第三方依赖**（只用 Node 内置能力 + 上面已有依赖）。

### 3. 启动

```bash
# 依赖已安装后
yarn dev            # NODE_ENV=development + nodemon，MEM_MOCK 未设置时默认 true
```

启动日志出现 `running in memory-mock mode` 与 `seed data injected: ...` 即为成功。自检：

```bash
curl http://127.0.0.1:3001/api/v1/health
curl http://127.0.0.1:3001/api/v1/datasources?page=1&size=20
curl http://127.0.0.1:3001/api/v1/statistics/overview
```

Docker（镜像构建时才在容器里安装生产依赖）：

```bash
docker build -t databridge-admin:mock .
docker run --rm -p 3001:3001 -e ENGINE_BASE_URL=http://host.docker.internal:8080 databridge-admin:mock
```

### 4. 已实现接口

| 分组 | 方法与路径（前缀 `/api/v1`） |
|------|------------------------------|
| 健康检查 | `GET /health` |
| 数据源 | `GET /datasources`、`POST /datasources`、`GET /datasources/:id`、`PUT /datasources/:id`、`DELETE /datasources/:id`、`POST /datasources/test`、`POST /datasources/:id/test` |
| 同步任务 | `GET /tasks`、`POST /tasks`、`GET /tasks/:id`、`PUT /tasks/:id`、`DELETE /tasks/:id`、`POST /tasks/:id/start`、`POST /tasks/:id/stop`、`GET /tasks/:id/progress`、`GET /tasks/:id/instances` |
| 任务实例 | `GET /task-instances`、`GET /task-instances/:id`、`GET /task-instances/:id/logs`、`GET /task-instances/:id/offsets` |
| 运维统计 | `GET /statistics/overview`（对标 FDL 运维监控大盘，见契约 1.5，不鉴权） |
| 引擎回调 | `POST /engine/report`、`POST /engine/logs`（Mock 阶段不鉴权） |
| 数据管道（契约 1.7） | `GET /pipelines`、`POST /pipelines`、`GET /pipelines/:id`、`PUT /pipelines/:id`、`DELETE /pipelines/:id`、`POST /pipelines/:id/start`、`POST /pipelines/:id/stop`、`GET /pipelines/:id/status` |
| 数据开发（契约 1.8） | `GET /dataflows`、`POST /dataflows`、`GET /dataflows/:id`、`PUT /dataflows/:id`、`DELETE /dataflows/:id`、`POST /dataflows/:id/run`、`POST /dataflows/:id/stop`、`GET /dataflows/:id/progress` |
| 数据服务·管理（契约 1.9） | `GET /data-apis`、`POST /data-apis`、`GET /data-apis/:id`、`PUT /data-apis/:id`、`DELETE /data-apis/:id`、`POST /data-apis/:id/publish`、`POST /data-apis/:id/unpublish`、`POST /data-apis/:id/invoke`、`GET /data-apis/:id/stats` |
| 数据服务·运行时（契约 1.9） | `GET /ds/{path}`（**不在** `/api/v1` 前缀内，由 `src/app.js` 顶层挂载） |
| 告警（契约 1.10） | `GET /alert-rules`、`POST /alert-rules`、`GET /alert-rules/:id`、`PUT /alert-rules/:id`、`DELETE /alert-rules/:id`、`GET /alert-records`、`GET /alert-records/:id`、`PATCH /alert-records/:id/read` |
| 数据血缘（契约 1.10） | `GET /lineage/graph` |

`GET /statistics/overview` 的 `result`：`{ datasourceTotal, taskTotal, runningInstances, todayTotal, todaySuccess,
todayFailed, todayStopped, recentTrend: [{ date, success, failed }] }`；今日与趋势均按实例 `startedAt` 的 **UTC 日期**
聚合，`recentTrend` 固定 7 条（含当天）且按日期升序，无数据的日期补 `0`。
实现位置：聚合在 `services/taskInstance.service.js#getStatisticsOverview()`（配合
`repositories/instance.repository.js` 新增的 `list()` / `countByStatus()`），HTTP 层是
`controllers/statistics.controller.js` + `routes/v1/statistics.route.js`。

响应统一信封 `{ code, message, result, timestamp }`，分页 `result = { items, total, page, size, pages }`。
业务错误码：`40001` 参数校验失败、`40002` 数据源被引用不可删除、`40003` running 中禁止编辑/删除、
`40401` 资源不存在、`40901` 重复启动、`50001/50002` 引擎不可达/引擎拒绝；
数据服务运行时另有 `40101` 未提供 API Key、`40102` API Key 无效、`40301` IP 不在白名单、
`42901` 超过限流 QPS、`40404` 服务不存在或未发布（HTTP 状态码分别为 401/401/403/429/404，
映射表在 `src/config/errorCodes.js`）。
数据源 `password` 响应中恒为 `"***"`；mock 连通测试规则：`host` 以 `10.` 开头或名称含 `fail` 即返回失败。

### 5. 任务对象字段（对标 FineDataLink）

除契约 1.2 的基础字段外，`POST /tasks` / `PUT /tasks/:id` 还支持以下可选字段。
其中 **`scheduleCron` / `retryCount` / `retryIntervalSec` 从 Mock 阶段起就是真实行为**
（调度器与失败重试见第 8 节），只有 `fieldMappings[].transform` 仍只存储回显、不进引擎快照：

| 字段 | 类型 | 默认 | 校验 | 说明 |
|------|------|------|------|------|
| `scheduleCron` | `string \| null` | `null` | 最长 64 字符 | Quartz 风格 6 位 cron 子集，`null` 表示仅手动触发；由 `services/scheduler.service.js` 每秒扫描触发 |
| `retryCount` | `number` | `3` | 整数 0~10 | 失败重试次数，收到 `failed` 回报后生效 |
| `retryIntervalSec` | `number` | `60` | 整数 0~86400 | 重试间隔（秒） |
| `fieldMappings[].transform` | `object \| null` | 缺省即 `null` | 见下 | 对标 FDL 转换组件占位，原样存取 |

`transform` 结构：`{ type: 'none'|'upper'|'lower'|'trim'|'constant'|'expression', value: string|null }`，
`type` 必填；`type` 为 `constant` / `expression` 时 `value` 必填且非空，其余类型 `value` 可为 `null`、
`''` 或缺省；整个 `transform` 允许显式传 `null` 表示不做转换。校验定义在
`src/validations/task.validation.js`（`TRANSFORM_TYPES` / `fieldMapping` / `baseKeys`），
非法取值返回 `40001`。

### 6. 种子数据

`MEM_MOCK=true` 时由 `src/repositories/seed.js` 注入：

- 3 个数据源：`ds-1001` 生产Oracle（host `10.0.0.11` → 连通测试必定失败）、`ds-1002` 业务MySQL（必定成功）、
  `ds-1003` 预发PostgreSQL(fail)（名称含 `fail` → 必定失败，且未被任务引用，可演示删除）
- 2 个任务：`task-2001` 订单表全量同步（`full`，带 4 条 fieldMappings，`lastStatus=running`，
  演示 40003 禁止编辑 / 40901 重复启动）、`task-2002` 订单明细增量同步（`incremental`，`incrementalColumn=UPDATE_TIME`，
  `lastStatus=success`，可自由编辑/删除/启动）
- 两个任务都带调度配置演示值：`task-2001` `scheduleCron='0 0 2 * * ?'` + `retryCount=3` + `retryIntervalSec=60`，
  `task-2002` `scheduleCron='0 30 1 * * ?'` + `retryCount=5` + `retryIntervalSec=120`；
  fieldMappings 里演示了 `transform` 的三种形态：`null`、`{ type: 'upper'|'trim', value: null }`、
  `{ type: 'constant', value: '0' }`（Mock 阶段仅回显，不做实际转换）
- 4 个实例（1 running / 2 success / 1 failed）、9 条日志（INFO/WARN/ERROR）、5 条 offset 点位，
  实例统一带 `trigger='manual'`
  —— 实例 `startedAt` 为固定的 2026-09-17~19，因此 `GET /statistics/overview` 的「今日」计数与
  `recentTrend` 会随真实运行日期变化，只有跑在 2026-09-19 当天时才有今日数据
- 1 条数据管道 `pipe-7001` 订单库实时镜像（`running`，`runningInstanceId=inst-3101`，
  运行态演示值 `changeRows=12480`、`currentQps=46`、`lagMs=820`、`cdcPosition=SCN=28461937451`；
  `lagMs` 故意低于规则阈值 5000，所以刚起来不会立刻刷告警）
- 1 条数据开发 `df-7501` 订单宽表加工（契约 1.8 的五节点画布 input→filter→join→validate→output，
  `scheduleCron=null` 即只手动 run）
- 1 条数据服务 `api-8001` 订单查询服务（`published`，演示 `apiKey=dk-9f3a1c2d...`、`invokeCount=138`、
  `rateLimitQps=20`，并给 `GET /data-apis/api-8001/stats` 铺了近 7 天的调用日志）
- 1 条告警规则 `ar-9001` 同步失败钉钉告警（三条件齐配、阈值 5000ms、通道 dingtalk mock）
  + 2 条告警记录（一条 `task_failed` 已读、一条管道 `lag` 未读，用于演示 `read` 筛选与 PATCH）

> 注意：因为调度器是真实运行的，种子任务 `task-2001`（`0 0 2 * * ?`）与 `task-2002`（`0 30 1 * * ?`）
> 会在每天 02:00 / 01:30（UTC）自动 `start` 一次。本机没起 Go 引擎时，日志里会看到
> `cron start failed for task-xxxx: 调用同步引擎失败...`，属于预期现象。
> 不想被自动触发就把 `scheduleCron` 置 `null` 或 `enabled=false`（`PUT /tasks/:id`）。

### 7. 分层与第二阶段替换点

`routes/v1/*.route.js`（HTTP 装配）→ `controllers/*`（仅出入参）→ `services/*`（业务）→
`repositories/*`（存储）。所有 DataBridge 仓储都是内存实现，接 PostgreSQL 时只替换
`src/repositories/*.repository.js` 的内部实现（保持 `find/page/getById/create/update/delete` 签名），
service / controller 不动。新路由当前不挂 `auth`，第二阶段在 route 文件里的 `TODO` 处补上即可。

第二阶段与本批增量相关的几处：`getStatisticsOverview()` 换成 SQL 聚合（`COUNT(*)` + `GROUP BY date(started_at)`），
返回结构不变；`run.service.js` 的「预写实例 + 下发引擎 + 回滚」换成事务化调度记录；
告警投递从写 `channelResult='mock-sent'` 换成真实机器人调用；数据血缘从实时聚合换成血缘表查询；
`fieldMappings[].transform` 则下发给 Go 引擎执行转换。

### 8. FineDataLink 对标的四个新模块（契约 1.7~1.10）

#### 8.1 数据管道 `/pipelines`（契约 1.7）

| 位置 | 文件 |
|------|------|
| 仓储 | `src/repositories/pipeline.repository.js`（`pipe-` 前缀，自增从 7000 起） |
| 业务 | `src/services/pipeline.service.js`（CRUD / start / stop / status / `applyEngineReport`） |
| HTTP | `src/controllers/pipeline.controller.js` + `src/routes/v1/pipeline.route.js` + `src/validations/pipeline.validation.js` |
| 引擎 | `src/utils/engineClient.js#startPipeline`（POST `/api/v1/engine/tasks/start`，`syncMode=cdc`、`taskId:null`、带 `syncObjects`） |

- `start`：校验（数据源存在、`syncObjects` 非空）→ 预写 `inst-` 实例（`syncMode=cdc`、`totalRows=null`）
  → 生成 `runningInstanceId` → 管道运行态清零并置 `running` → 下发 cdc 快照；引擎拒绝（409/404/超时）时
  回滚实例与管道记录，重复启动 `40901`，`running` 中改删 `40003`。`stop` 同理走 `engineClient.stopTask`。
- `GET /pipelines/:id/status` 读的就是管道记录上的运行态字段（`changeRows` / `currentQps` / `lagMs`
  / `cdcPosition` / `startedAt`），由引擎回报刷新，前端 3s 轮询即可。
- 引擎回报带 `pipelineId` 时（`POST /engine/report`）：刷运行态；进入终态则 `status=stopped`、
  `runningInstanceId=null`，失败时写 `lastError`。

#### 8.2 定时调度与失败重试（契约 1.6，真实行为）

| 位置 | 文件 |
|------|------|
| cron 匹配 | `src/utils/cronMatcher.js`（纯函数 `matchesCron(cron, dateUTC)` / `isSupportedCron(cron)`） |
| 调度器 | `src/services/scheduler.service.js`（仅 `MEM_MOCK` 下由 `src/index.js` 调 `startScheduler()`） |
| 运行编排 | `src/services/run.service.js`（task 与 dataflow 共用的 start/stop/progress + `scheduleRetry`） |
| 接入点 | `src/services/engineReport.service.js`（`failed` 回报 → 告警 + 重试排程） |

- **支持的 cron 子集**：6 段「秒 分 时 日 月 周」，每段只支持 `*`、`?`（等同 `*`）、单个数字（需在取值范围内）；
  星期按 Quartz 习惯 `1=周日…7=周六`（也接受 `0=周日`），其余按 UTC。
  区间 `1-5`、列表 `1,3`、步长 `0/5`、英文名 `MON`、段数不是 6 等写法**不会命中**（不误触发），
  调度器对这类表达式只 WARN 一次。示例：`0 0 2 * * ?`（每天 02:00:00 UTC）、`0 30 1 * * ?`、`* * * * * ?`（每秒）。
- **调度器**：`setInterval` 每秒扫一遍所有 `enabled` 且配了 `scheduleCron` 的任务与数据开发流程，
  命中且「同一条记录距上次触发 > 60s」且当前没有 running 实例时调 `start({trigger:'cron'})`；
  running 中跳过并记 WARN；引擎不可达只记日志，不影响调度器存活。`stopScheduler()` / `shutdownScheduling()`
  在 `exitHandler` 与 `SIGTERM` 里调用（定时器都 `unref()`，不会把进程挂住）。
- **失败重试**：实例回报 `failed` 且运行体 `retryCount>0`、链上已重试次数（实例 `retryAttempt`）未用满时，
  等 `retryIntervalSec` 秒后以 `trigger='retry'`、`retryAttempt+1` 重新下发，并在老实例上写
  `第 N 次重试` 的 INFO 日志；排程期间若被人工启动或删除则放弃。
- 实例对象新增 `trigger`（`manual|cron|retry`）与 `retryAttempt`，`GET /task-instances` 支持按
  `trigger` / `pipelineId` 过滤，`GET /tasks/:id/progress`、`GET /dataflows/:id/progress` 响应里也带这两个字段。

#### 8.3 数据开发 `/dataflows`（契约 1.8）

| 位置 | 文件 |
|------|------|
| 仓储 | `src/repositories/dataflow.repository.js`（`df-` 前缀，自增从 7500 起） |
| 业务 | `src/services/dataflow.service.js`（画布深校验 + run/stop/progress，运行链路复用 `run.service.js`） |
| HTTP | `src/controllers/dataflow.controller.js` + `src/routes/v1/dataflow.route.js` + `src/validations/dataflow.validation.js` |

- 画布深校验（结构走 Joi，跨字段走 `canvasRule` + service 兜底，全部 40001）：节点 `id` 唯一、
  `type ∈ input|output|filter|transform|join|union|sql|json_parse|validate`、`config` 必须是对象、
  `edges` 只能引用已存在的节点 id、至少一个 `input` 与一个 `output`，且 input/output 必须带
  `config.datasourceId`（数据源要存在）与 `config.table`。
- `run`：取**首个 input** 与**最后一个 output** 拼一份 `full` 模式引擎快照（`taskId` 位置传 `dataflowId`），
  实例记录同样以 `taskId=dataflowId` 承载，因此进度、日志、点位、重试、告警都能按同一套逻辑复用；
  响应 `{ dataflowId, instanceId, status }`。`GET /dataflows/:id/progress` 结构与 `/tasks/:id/progress`
  完全一致（键名仍是 `taskId`，值是 `df-xxxx`）。
- 调度字段与重试行为同 8.2（`scheduleCron` / `retryCount` / `retryIntervalSec` 与任务同构）。

#### 8.4 数据服务 `/data-apis` + 运行时 `/ds`（契约 1.9）

| 位置 | 文件 |
|------|------|
| 仓储 | `src/repositories/dataapi.repository.js`（`api-` 前缀，自增从 8000 起；调用日志单独用模块级 Map，最多 1000 条） |
| 管理业务 | `src/services/dataApi.service.js`（CRUD / publish / unpublish / invoke 代理 / stats） |
| 运行时网关 | `src/services/dataApiRuntime.service.js`（鉴权 / 白名单 / 限流 / mock 出数 / 统计累加） |
| HTTP | `src/controllers/dataapi.controller.js` + `src/routes/v1/dataapi.route.js`；`src/controllers/ds.controller.js` + `src/routes/ds.route.js`（`app.js` 顶层挂 `/ds`） |
| 纯逻辑 | `src/utils/rateWindow.js`（1s 窗口计数）、`src/utils/mockRows.js`（mulberry32 + FNV 种子的确定性行） |

- `publish` 用 `crypto.randomBytes(16)` 生成 `apiKey`（`dk-` + 32 位 hex），已发布时重复调用**不换 key**；
  `unpublish` 只把状态打回 `draft`，运行时立刻 `404/40404`。
- 运行时 `GET /ds/{path}` 的判定顺序：路径不存在/未发布 `404/40404` → 缺 Key `401/40101` →
  Key 不符 `401/40102` → IP 不在白名单 `403/40301` → 超 QPS `429/42901` → 出数据。
  Key 可走 `X-API-Key` 头或 `apiKey` 查询参数；来源 IP 依次取 `x-forwarded-for` 首跳、`x-real-ip`、`req.ip`
  （本服务没开 express `trust proxy`，所以这里手工解析）；白名单支持精确匹配与 `10.0.0.*` 前缀写法，
  `::ffff:a.b.c.d` 会归一化成 IPv4 再比对。
- 出数是**确定性**的：种子 `tableName|page|size`，同一页永远返回同样的行；`fields` 按声明类型给值
  （整型/小数（尊重 `precision,scale`）/字符串/日期时间/布尔），`total` 按种子落在 30~90，
  响应 `result = { fields: ['ID',...], rows: [[...]], total, page, size }`，支持 `page`/`size`/`limit`。
- 每次命中已发布 API 的调用都累加 `invokeCount` 与 `avgLatencyMs`（`performance.now()` 实测），
  被 401/403/429 拒绝的再累加 `errorCount`；`GET /data-apis/:id/stats` 的 `recentTrend` 与运维大盘同口径
  （UTC 日期、固定 7 天，元素 `{ date, count, errors, avgLatencyMs }`）。
- `POST /data-apis/:id/invoke` 是**服务端内部直接调 runtime 函数**（不发 HTTP 请求），
  返回 `{ httpStatus, body }`，`body` 就是外部调用会拿到的完整信封，前端「调试」按钮据此判断。

#### 8.5 告警与血缘（契约 1.10）

| 位置 | 文件 |
|------|------|
| 仓储 | `src/repositories/alertrule.repository.js`（`ar-`，9000 起）、`src/repositories/alertrecord.repository.js`（`rec-`） |
| 业务 | `src/services/alert.service.js`（规则 CRUD、记录查询/标记已读、`fireEvent` 判定与投递）、`src/services/lineage.service.js` |
| HTTP | `src/controllers/alertrule.controller.js`、`src/controllers/alertrecord.controller.js`、`src/controllers/lineage.controller.js` + 对应 `routes/v1/*.route.js`、`validations/*.validation.js` |

- 触发点全部挂在引擎回报上：实例 `failed` → `task_failed`；管道进终态且 `failed`（写 `lastError`）→
  `pipeline_error`；管道 `lagMs` 高于规则 `thresholdLagMs` → `lag_over_threshold`（同管道 + 同规则 60s 去重）。
  规则的 `scope` 支持 `all|task|dataflow|pipeline`（`task` 同时覆盖数据开发）。
- 命中后**为每个 channel 写一条** alert-record，`channelResult='mock-sent'`，不发真实 webhook；
  规则没配通道时写一条 `channel='none'` 的记录（否则告警中心看不到这次触发）。内存里最多留 1000 条，超出丢最旧。
- `GET /lineage/graph` 由五类定义实时聚合：数据源 → 表（`{datasourceId}:{table}`）→ 任务/管道/流程 →
  目标表 → 数据服务；节点与边都去重，`type` 为 `datasource|table|task|pipeline|dataflow|dataapi`。

#### 8.6 自检命令

```bash
curl http://127.0.0.1:3001/api/v1/pipelines
curl http://127.0.0.1:3001/api/v1/pipelines/pipe-7001/status
curl -X POST http://127.0.0.1:3001/api/v1/dataflows/df-7501/run
curl http://127.0.0.1:3001/api/v1/data-apis/api-8001/stats
curl 'http://127.0.0.1:3001/ds/order-query?page=1&size=5' -H 'X-API-Key: dk-9f3a1c2d4e5f60718293a4b5c6d7e8f9'
curl http://127.0.0.1:3001/api/v1/alert-records?read=false
curl http://127.0.0.1:3001/api/v1/lineage/graph
```
