import Debug from '@prisma/debug'
import stripAnsi from 'strip-ansi'
import {
  PrismaClientInitializationError,
  PrismaClientKnownRequestError,
  PrismaClientRustPanicError,
  PrismaClientUnknownRequestError,
} from '.'
import { DataLoader } from './DataLoader'
import { RequestParams, Unpacker } from './getPrismaClient'
import { Args, Document, unpack } from './query'
import { printStack } from './utils/printStack'
import { throwIfNotFound } from './utils/rejectOnNotFound'
const debug = Debug('prisma:client:fetcher')

export class RequestHandler {
  prisma: any
  hooks: any
  dataLoader: DataLoader<{
    document: Document
    runInTransaction?: boolean
    transactionId?: number
    headers?: Record<string, string>
  }>

  constructor(prisma, hooks?: any) {
    this.prisma = prisma
    this.hooks = hooks
    this.dataLoader = new DataLoader({
      batchLoader: (requests) => {
        const queries = requests.map((r) => String(r.document))

        return this.prisma._engine.requestBatch(queries)
      },
      singleLoader: (request) => {
        const query = String(request.document)

        return this.prisma._engine.request(query, request.headers)
      },
      batchBy: (request) => {
        if (!request.document.children[0].name.startsWith('findUnique')) {
          return
        }

        const selectionSet = request.document.children[0].children!.join(',')

        const args = request.document.children[0].args?.args
          .map((a) => {
            if (a.value instanceof Args) {
              return `${a.key}-${a.value.args.map((a) => a.key).join(',')}`
            }
            return a.key
          })
          .join(',')

        return `${request.document.children[0].name}|${args}|${selectionSet}`
      },
    })
  }

  async request({
    document,
    dataPath = [],
    rootField,
    typeName,
    isList,
    callsite,
    rejectOnNotFound,
    clientMethod,
    runInTransaction,
    showColors,
    engineHook,
    args,
    headers,
    transactionId,
    unpacker,
  }: RequestParams) {
    if (this.hooks && this.hooks.beforeRequest) {
      const query = String(document)
      this.hooks.beforeRequest({
        query,
        path: dataPath,
        rootField,
        typeName,
        document,
        isList,
        clientMethod,
        args,
      })
    }
    try {
      /**
       * If there's an engine hook, use it here
       */
      let data, elapsed
      if (engineHook) {
        const result = await engineHook(
          {
            document,
            runInTransaction,
          },
          (params) => this.dataLoader.request(params),
        )
        data = result.data
        elapsed = result.elapsed
      } else {
        const result = await this.dataLoader.request({
          document,
          runInTransaction,
          headers,
          transactionId,
        })
        data = result?.data
        elapsed = result?.elapsed
      }

      /**
       * Unpack
       */
      const unpackResult = this.unpack(
        document,
        data,
        dataPath,
        rootField,
        unpacker,
      )
      throwIfNotFound(unpackResult, clientMethod, typeName, rejectOnNotFound)
      if (process.env.PRISMA_CLIENT_GET_TIME) {
        return { data: unpackResult, elapsed }
      }
      return unpackResult
    } catch (e) {
      debug(e)
      let message = e.message
      if (callsite) {
        const { stack } = printStack({
          callsite,
          originalMethod: clientMethod,
          onUs: e.isPanic,
          showColors,
        })
        message = `${stack}\n  ${e.message}`
      }

      message = this.sanitizeMessage(message)
      // TODO: Do request with callsite instead, so we don't need to rethrow
      if (e.code) {
        throw new PrismaClientKnownRequestError(
          message,
          e.code,
          this.prisma._clientVersion,
          e.meta,
        )
      } else if (e.isPanic) {
        throw new PrismaClientRustPanicError(
          message,
          this.prisma._clientVersion,
        )
      } else if (e instanceof PrismaClientUnknownRequestError) {
        throw new PrismaClientUnknownRequestError(
          message,
          this.prisma._clientVersion,
        )
      } else if (e instanceof PrismaClientInitializationError) {
        throw new PrismaClientInitializationError(
          message,
          this.prisma._clientVersion,
        )
      } else if (e instanceof PrismaClientRustPanicError) {
        throw new PrismaClientRustPanicError(
          message,
          this.prisma._clientVersion,
        )
      }

      e.clientVersion = this.prisma._clientVersion

      throw e
    }
  }

  sanitizeMessage(message) {
    if (this.prisma._errorFormat && this.prisma._errorFormat !== 'pretty') {
      return stripAnsi(message)
    }
    return message
  }
  unpack(document, data, path, rootField, unpacker?: Unpacker) {
    if (data?.data) {
      data = data.data
    }
    // to lift up _all in count
    if (unpacker) {
      data[rootField] = unpacker(data[rootField])
    }

    const getPath: any[] = []
    if (rootField) {
      getPath.push(rootField)
    }
    getPath.push(...path.filter((p) => p !== 'select' && p !== 'include'))
    return unpack({ document, data, path: getPath })
  }

  get [Symbol.toStringTag]() {
    return 'PrismaClientFetcher'
  }
}
