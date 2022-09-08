/*****
 License
 --------------
 Copyright © 2017 Bill & Melinda Gates Foundation
 The Mojaloop files are made available by the Bill & Melinda Gates Foundation under the Apache License, Version 2.0 (the "License") and you may not use these files except in compliance with the License. You may obtain a copy of the License at
 http://www.apache.org/licenses/LICENSE-2.0
 Unless required by applicable law or agreed to in writing, the Mojaloop files are distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 Contributors
 --------------
 This is the official list of the Mojaloop project contributors for this file.
 Names of the original copyright holders (individuals or organizations)
 should be listed with a '*' in the first column. People who have
 contributed from an organization can be listed under the organization
 that actually holds the copyright for their contributions (see the
 Gates Foundation organization for an example). Those individuals should have
 their names indented and be marked with a '-'. Email address can be added
 optionally within square brackets <email>.
 * Gates Foundation
 - Name Surname <name.surname@gatesfoundation.com>

 * Jason Bruwer <jason.bruwer@coil.com>

 --------------
 ******/
'use strict'

const ErrorHandler = require('@mojaloop/central-services-error-handling')
const Logger = require('@mojaloop/central-services-logger')
const TbNode = require('tigerbeetle-node')
const createClient = TbNode.createClient
const Config = require('../lib/config')
const util = require('util')
const crypto = require('crypto')
const uuidv4Gen = require('uuid4')

let tbCachedClient

// TODO const inFlight = []

// const secret = 'This is a secret 🤫'

const getTBClient = async () => {
  try {
    if (!Config.TIGERBEETLE.enabled) {
      const fspiopError = ErrorHandler.Factory.createFSPIOPError(ErrorHandler.Enums.FSPIOPErrorCodes.MODIFIED_REQUEST,
        'TB-Client is not enabled.')
      throw fspiopError
    }

    if (tbCachedClient == null) {
      Logger.info('TB-Client-Enabled. Connecting to R-01 ' + Config.TIGERBEETLE.replicaEndpoint01)

      tbCachedClient = await createClient({
        cluster_id: Config.TIGERBEETLE.cluster,
        replica_addresses: [Config.TIGERBEETLE.replicaEndpoint01]
      })
    }
    Logger.info(`TB-Client-Enabled and Connected [${Config.TIGERBEETLE.cluster}:${Config.TIGERBEETLE.replicaEndpoint01}]. ${util.inspect(tbCachedClient)}`)
    return tbCachedClient
  } catch (err) {
    throw ErrorHandler.Factory.reformatFSPIOPError(err)
  }
}

/**
 * Create a Hub account used for settlement.
 *
 * @param id Hub/Hub Recon id
 * @param accountType Numeric account type for Hub or Hub Recon
 *    1->POSITION
 *    2->SETTLEMENT
 *    3->HUB_RECONCILIATION
 *    4->HUB_MULTILATERAL_SETTLEMENT
 *    5->INTERCHANGE_FEE
 *    6->INTERCHANGE_FEE_SETTLEMENT
 * @param currencyTxt ISO-4217 alphabetic code
 */
const tbCreateSettlementHubAccount = async (
  id,
  accountType = 2,
  currencyTxt = 'USD'
) => {
  try {
    const client = await getTBClient()
    if (client == null) return {}

    const userData = BigInt(id)
    const currencyU16 = obtainLedgerFromCurrency(currencyTxt)
    const tbId = tbAccountIdFrom(userData, currencyU16, accountType)

    const account = {
      id: tbId,
      user_data: userData, // u128, opaque third-party identifier to link this account (many-to-one) to an external entity:
      reserved: Buffer.alloc(48, 0), // [48]u8
      ledger: currencyU16, // u32, currency
      code: accountType, // u16, settlement
      flags: 0, // u32
      debits_pending: 0n, // u64
      debits_posted: 0n, // u64
      credits_pending: 0n, // u64
      credits_posted: 0n, // u64
      timestamp: 0n // u64, Reserved: This will be set by the server.
    }

    let errors
    try {
      if (Config.TIGERBEETLE.enableMockBeetle) errors = []
      else errors = await client.createAccounts([account])
    } catch (err) {
      const fspiopError = ErrorHandler.Factory.createFSPIOPError(ErrorHandler.Enums.FSPIOPErrorCodes.MODIFIED_REQUEST,
          `TB-Account-CRITICAL [${err}] : ${util.inspect(errors)}`)
      throw fspiopError
    }
    if (errors.length > 0) {
      const errorTxt = errorsToString(TbNode.CreateAccountError, errors)

      Logger.error('CreateAccount-ERROR: ' + errorTxt)
      const fspiopError = ErrorHandler.Factory.createFSPIOPError(ErrorHandler.Enums.FSPIOPErrorCodes.MODIFIED_REQUEST,
        'TB-Account entry failed for [' + userData + ':' + errorTxt + '] : ' + util.inspect(errors))
      throw fspiopError
    }
    console.info(`JASON::: 1.3 Accounts Created -> ${util.inspect(errors)} - ${errors}   `)
    return errors
  } catch (err) {
    console.error('TB: Unable to create account.')
    console.error(err)
    throw ErrorHandler.Factory.reformatFSPIOPError(err)
  }
}

/**
 * Create all the settlement accounts.
 *
 * @param id Hub/Hub Recon/DFSPS id
 * @param accountType Numeric account type
 * @param currencyTxt ISO-4217 alphabetic code
 */
const tbCreateSettlementAccounts = async (
  settlementAccounts,
  settlementId,
  accountType = 2,
  currencyTxt,
  debitsNotExceedCredits
) => {
  try {
    const client = await getTBClient()

    const tbAccountsArray = []
    for (const accIter of settlementAccounts) {
      const userData = BigInt(settlementId)
      const participantCurrencyId = BigInt(accIter.participantCurrencyId)
      const currencyU16 = obtainLedgerFromCurrency(currencyTxt)
      const id = tbSettlementAccountIdFrom(participantCurrencyId, userData)

      tbAccountsArray.push({
        id,
        user_data: userData, // u128, settlementId
        reserved: Buffer.alloc(48, 0), // [48]u8
        ledger: currencyU16, // u32, currency
        code: accountType, // u16, settlement
        flags: debitsNotExceedCredits ? TbNode.AccountFlags.debits_must_not_exceed_credits : 0, // u32
        debits_pending:  0n, // u64
        debits_posted:   0n, // u64
        credits_pending: 0n, // u64
        credits_posted:  0n, // u64
        timestamp: 0n // u64, Reserved: This will be set by the server.
      })
    }

    let errors
    if (Config.TIGERBEETLE.enableMockBeetle) {
      errors = []
    } else {
      console.log('All good with creating settlement accounts')
      errors = await client.createAccounts(tbAccountsArray)
    }
    if (errors.length > 0) {
      const errorTxt = errorsToString(TbNode.CreateAccountError, errors)

      Logger.error('CreateAccount-ERROR: ' + errorTxt)
      const fspiopError = ErrorHandler.Factory.createFSPIOPError(ErrorHandler.Enums.FSPIOPErrorCodes.MODIFIED_REQUEST,
        `TB-Account entry failed for [${errorTxt}] : ${util.inspect(errors)}`)
      throw fspiopError
    }
    return errors
  } catch (err) {
    console.error('TB: Unable to create account.')
    console.error(err)
    throw ErrorHandler.Factory.reformatFSPIOPError(err)
  }
}

const tbLookupHubAccount = async (
  id,
  accountType = 2,
  currencyTxt = 'USD'
) => {
  try {
    const client = await getTBClient()
    if (client == null) return {}

    const userData = BigInt(id)
    const currencyU16 = obtainLedgerFromCurrency(currencyTxt)
    const tbId = tbAccountIdFrom(userData, currencyU16, accountType)

    if (Config.TIGERBEETLE.enableMockBeetle) {
      return {
        tbId,
        user_data: userData, // u128, settlementId
        reserved: Buffer.alloc(48, 0), // [48]u8
        ledger: currencyU16, // u32, currency
        code: accountType, // u16, settlement
        flags: 0, // u32
        debits_pending: 0n, // u64
        debits_posted: 0n, // u64
        credits_pending: 0n, // u64
        credits_posted: 0n, // u64
        timestamp: 0n
      }
    }

    const accounts = await client.lookupAccounts([tbId])
    if (accounts.length > 0) return accounts[0]
    return {}
  } catch (err) {
    throw ErrorHandler.Factory.reformatFSPIOPError(err)
  }
}

/**
 * Settlement obligation has been created via `createSettlementEvent`.
 * After this is called, we should be in a settlement state of
 * `PENDING_SETTLEMENT` -> `PS_TRANSFERS_RECORDED`
 *
 * @param settlementTransferId
 * @param orgTransferId
 * @param settlementId
 * @param drParticipantCurrencyIdHub
 * @param drParticipantCurrencyIdHubRecon
 * @param crParticipantCurrencyIdDFSP
 * @param currencyTxt
 * @param amount
 * @returns {Promise<{}|*>}
 */
const tbSettlementPreparationTransfer = async (
  enums,
  settlementTransferId,
  orgTransferId,
  settlementId,
  drParticipantCurrencyIdHubRecon,
  crDrParticipantCurrencyIdHubMultilateral,
  crParticipantCurrencyIdDFSP,
  currencyTxt,
  amount
) => {
  try {
    const client = await getTBClient()
    if (client == null) return {}

    const currencyU16 = obtainLedgerFromCurrency(currencyTxt)
    const transferRecon = {
      id: uuidToBigInt(settlementTransferId), // u128
      debit_account_id: BigInt(drParticipantCurrencyIdHubRecon), // u128
      credit_account_id: BigInt(crDrParticipantCurrencyIdHubMultilateral), // u128
      user_data: BigInt(settlementId),
      reserved: BigInt(0),
      pending_id: 0,
      timeout: 0n, // u64, in nano-seconds.
      ledger: currencyU16,
      code: enums.ledgerAccountTypes.HUB_MULTILATERAL_SETTLEMENT,
      flags: TbNode.TransferFlags.linked, // linked
      amount: BigInt(amount), // u64
      timestamp: 0n // u64, Reserved: This will be set by the server.
    }

    const partCurrencyId = tbSettlementAccountIdFrom(crParticipantCurrencyIdDFSP, settlementId)
    const transferDFSPToHub = {
      id: uuidToBigInt(`${uuidv4Gen()}`),
      debit_account_id: BigInt(crDrParticipantCurrencyIdHubMultilateral), // u128
      credit_account_id: BigInt(partCurrencyId), // u128
      user_data: uuidToBigInt(orgTransferId),
      reserved: BigInt(0), // two-phase condition can go in here / Buffer.alloc(32, 0)
      pending_id: 0,
      timeout: 0n, // u64, in nano-seconds.
      ledger: currencyU16,
      code: enums.ledgerAccountTypes.SETTLEMENT, // u32
      flags: 0, // u32 (last txn in the chain of lined events)
      amount: BigInt(amount), // u64
      timestamp: 0n // u64, Reserved: This will be set by the server.
    }

    let errors
    if (Config.TIGERBEETLE.enableMockBeetle) {
      errors = []
    } else {
      errors = await client.createTransfers([transferRecon, transferDFSPToHub])
    }
    if (errors.length > 0) {
      const errorTxt = errorsToString(TbNode.CreateTransferError, errors)

      Logger.error('Transfer-ERROR: ' + errorTxt)
      const fspiopError = ErrorHandler.Factory.createFSPIOPError(ErrorHandler.Enums.FSPIOPErrorCodes.MODIFIED_REQUEST,
        'TB-Transfer-Preparation entry failed for [' + settlementTransferId + ':' + errorTxt + '] : ' + util.inspect(errors))
      throw fspiopError
    }
    return errors
  } catch (err) {
    throw ErrorHandler.Factory.reformatFSPIOPError(err)
  }
}

const tbSettlementTransferReserve = async (
  enums,
  settlementTransferId,
  settlementId,
  drParticipantCurrencyIdDFSP,
  crDrParticipantCurrencyIdHubMultilateral,
  crParticipantCurrencyIdHubRecon,
  currencyTxt,
  amount
) => {
  try {
    const client = await getTBClient()
    if (client == null) return {}

    const currencyU16 = obtainLedgerFromCurrency(currencyTxt)

    const transferHubToDFSPReserve = {
      id: tbMultilateralTransferSettlementId(settlementId, settlementTransferId, 1),
      debit_account_id: BigInt(drParticipantCurrencyIdDFSP), // u128
      credit_account_id: BigInt(crDrParticipantCurrencyIdHubMultilateral), // u128
      user_data: BigInt(settlementId),
      reserved: BigInt(0),
      pending_id: 0,
      timeout: 0n, // u64, in nano-seconds.
      ledger: currencyU16,
      code: enums.ledgerAccountTypes.SETTLEMENT,
      flags: TbNode.TransferFlags.linked | TbNode.TransferFlags.pending, // pending+linked
      amount: BigInt(amount), // u64
      timestamp: 0n // u64, Reserved: This will be set by the server.
    }

    const transferMultiToRecon = {
      id: tbMultilateralTransferSettlementId(settlementId, settlementTransferId, 2),
      debit_account_id: BigInt(crDrParticipantCurrencyIdHubMultilateral), // u128
      credit_account_id: BigInt(crParticipantCurrencyIdHubRecon), // u128
      user_data: uuidToBigInt(settlementTransferId),
      reserved: BigInt(0),
      pending_id: 0,
      timeout: 0n, // u64, in nano-seconds.
      ledger: currencyU16,
      code: enums.ledgerAccountTypes.HUB_RECONCILIATION,
      flags: TbNode.TransferFlags.pending, // linked+pending
      amount: BigInt(amount), // u64
      timestamp: 0n // u64, Reserved: This will be set by the server.
    }

    let errors
    if (Config.TIGERBEETLE.enableMockBeetle) {
      errors = []
    } else {
      errors = await client.createTransfers([transferHubToDFSPReserve, transferMultiToRecon])
    }
    if (errors.length > 0) {
      const errorTxt = errorsToString(TbNode.CreateTransferError, errors)

      Logger.error('Transfer-ERROR: ' + errorTxt)
      const fspiopError = ErrorHandler.Factory.createFSPIOPError(ErrorHandler.Enums.FSPIOPErrorCodes.MODIFIED_REQUEST,
        'TB-Transfer-Preparation entry failed for [' + settlementTransferId + ':' + errorTxt + '] : ' + util.inspect(errors))
      throw fspiopError
    }
    return errors
  } catch (err) {
    throw ErrorHandler.Factory.reformatFSPIOPError(err)
  }
}

const tbSettlementTransferCommit = async (
  settlementTransferId,
  settlementId
) => {
  try {
    const client = await getTBClient()
    if (client == null) return {}

    const commits = [
      {
        id: uuidToBigInt(`${uuidv4Gen()}`),
        debit_account_id: 0n, // u128
        credit_account_id: 0n, // u128
        user_data: 0n,
        reserved: BigInt(0),
        pending_id: tbMultilateralTransferSettlementId(settlementId, settlementTransferId, 1),
        timeout: 0n, // u64, in nano-seconds.
        ledger: 0n,
        code: 0n,
        flags: TbNode.TransferFlags.linked | TbNode.TransferFlags.post_pending_transfer, // post
        amount: 0n, // u64
        timestamp: 0n // u64, Reserved: This will be set by the server.
      }, {
        id: uuidToBigInt(`${uuidv4Gen()}`),
        debit_account_id: 0n, // u128
        credit_account_id: 0n, // u128
        user_data: 0n,
        reserved: BigInt(0),
        pending_id: tbMultilateralTransferSettlementId(settlementId, settlementTransferId, 2),
        timeout: 0n, // u64, in nano-seconds.
        ledger: 0n,
        code: 0n,
        flags: TbNode.TransferFlags.post_pending_transfer, // post
        amount: 0n, // u64
        timestamp: 0n // u64, Reserved: This will be set by the server.
      }
    ]

    let errors
    if (Config.TIGERBEETLE.enableMockBeetle) {
      errors = []
    } else {
      errors = await client.createTransfers(commits)
    }
    if (errors.length > 0) {
      const errorTxt = errorsToString(TbNode.CreateTransferError, errors)
      Logger.error('Transfer-ERROR: ' + errorTxt)
      const fspiopError = ErrorHandler.Factory.createFSPIOPError(ErrorHandler.Enums.FSPIOPErrorCodes.MODIFIED_REQUEST,
        'TB-Transfer-Preparation entry failed for [' + settlementTransferId + ':' + errorTxt + '] : ' + util.inspect(errors))
      throw fspiopError
    }
    return errors
  } catch (err) {
    throw ErrorHandler.Factory.reformatFSPIOPError(err)
  }
}

const tbSettlementTransferAbort = async (
  settlementTransferId,
  settlementId
) => {
  try {
    const client = await getTBClient()
    if (client == null) return {}

    const aborts = [
      {
        id: uuidToBigInt(`${uuidv4Gen()}`),
        debit_account_id: 0n, // u128
        credit_account_id: 0n, // u128
        user_data: 0n,
        reserved: BigInt(0),
        pending_id: tbMultilateralTransferSettlementId(settlementId, settlementTransferId, 1),
        timeout: 0n, // u64, in nano-seconds.
        ledger: 0n,
        code: 0n,
        flags: TbNode.TransferFlags.linked | TbNode.TransferFlags.void_pending_transfer, // void
        amount: 0n, // u64
        timestamp: 0n // u64, Reserved: This will be set by the server.
      }, {
        id: uuidToBigInt(`${uuidv4Gen()}`),
        debit_account_id: 0n, // u128
        credit_account_id: 0n, // u128
        user_data: 0n,
        reserved: BigInt(0),
        pending_id: tbMultilateralTransferSettlementId(settlementId, settlementTransferId, 2),
        timeout: 0n, // u64, in nano-seconds.
        ledger: 0n,
        code: 0n,
        flags: TbNode.TransferFlags.void_pending_transfer, // void
        amount: 0n, // u64
        timestamp: 0n // u64, Reserved: This will be set by the server.
      }
    ]

    let errors
    if (Config.TIGERBEETLE.enableMockBeetle) {
      errors = []
    } else {
      errors = await client.createTransfers(aborts)
    }
    if (errors.length > 0) {
      const errorTxt = errorsToString(TbNode.CreateTransferError, errors)

      Logger.error('Transfer-ERROR: ' + errorTxt)
      const fspiopError = ErrorHandler.Factory.createFSPIOPError(ErrorHandler.Enums.FSPIOPErrorCodes.MODIFIED_REQUEST,
        'TB-Transfer-Preparation entry failed for [' + settlementTransferId + ':' + errorTxt + '] : ' + util.inspect(errors))
      throw fspiopError
    }
    return errors
  } catch (err) {
    throw ErrorHandler.Factory.reformatFSPIOPError(err)
  }
}

const tbDestroy = async () => {
  try {
    if (tbCachedClient == null) return {}
    Logger.info('Destroying TB client')
    tbCachedClient.destroy()
    tbCachedClient = undefined
  } catch (err) {
    throw ErrorHandler.Factory.reformatFSPIOPError(err)
  }
}

const obtainLedgerFromCurrency = (currencyTxt) => {
  switch (currencyTxt) {
    case 'KES' : return 404
    case 'ZAR' : return 710
    default : return 840// USD
  }
}

const errorsToString = (resultEnum, errors) => {
  let errorListing = ''
  for (const val of errors) {
    errorListing = errorListing.concat(`[${val.code}:${enumLabelFromCode(resultEnum, val.code)}],`)
  }
  return errorListing
}

const tbAccountIdFrom = (userData, currencyTxt, accountTypeNumeric) => {
  return sha256(`${userData}-${currencyTxt}-${accountTypeNumeric}`)
}

const tbSettlementAccountIdFrom = (partCurrencyId, settlementId) => {
  return sha256(`${partCurrencyId}-${settlementId}`)
}

const tbMultilateralTransferSettlementId = (settlementId, settlementTransferId, qualifier) => {
  return sha256(`${settlementId}-${settlementTransferId}-${qualifier}`)
}

const sha256 = (txt) => {
  const hashSha256 = crypto.createHash('sha256')
  let hash = hashSha256.update(txt)
  hash = hashSha256.digest(hash).toString('hex')
  // TODO need to remove this, and retest:
  hash = hash.substring(0, 32)// 6107f0019cf7ff3bd35c7566c9dd3ae4530ead129527e091191f8ce04421f816
  return BigInt(BigInt(`0x${hash}`).toString() / 2)
}

const uuidToBigInt = (uuid) => {
  return BigInt('0x' + uuid.replace(/-/g, ''))
}

const enumLabelFromCode = (resultEnum, errCode) => {
  const errorEnum = Object.keys(resultEnum)
  return errorEnum[errCode + ((errorEnum.length / 2) - 1)]
}

module.exports = {
  // Accounts:
  tbCreateSettlementAccounts,
  tbCreateSettlementHubAccount,
  tbLookupHubAccount,
  // Transfers:
  tbSettlementPreparationTransfer,
  tbSettlementTransferReserve,
  tbSettlementTransferCommit,
  tbSettlementTransferAbort,
  // Cleanup:
  tbDestroy
}
