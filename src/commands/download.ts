import Portal from '../services/portal'; // why do I have to add the .js here?
import { Configuration, Tokens } from 'ordercloud-javascript-sdk';
import { SerializedMarketplace } from '../models/serialized-marketplace';
import OrderCloudBulk from '../services/ordercloud-bulk';
import { defaultLogger, LogCallBackFunc, MessageType } from '../services/logger';
import { BuildResourceDirectory } from '../models/oc-resource-directory';
import jwt_decode from "jwt-decode";
import { OCResource } from '../models/oc-resources';
import _  from 'lodash';
import { MARKETPLACE_ID, ORDERCLOUD_URLS, REDACTED_MESSAGE } from '../constants';
import PortalAPI from '../services/portal';

export interface DownloadArgs {
    username?: string; 
    password?: string; 
    environment?: string;
    marketplaceID: string; 
    portalToken?: string;
    logger?: LogCallBackFunc
}

export async function download(args: DownloadArgs): Promise<SerializedMarketplace | void> {
    var { 
        username, 
        password, 
        environment,
        marketplaceID, 
        portalToken,
        logger = defaultLogger
    } = args;
    var validEnvironments = ['staging', 'sandbox', 'prod'];
   
    if (!marketplaceID) {
        return logger(`Missing required argument: marketplaceID`, MessageType.Error);
    }

    if (!validEnvironments.includes(environment)) {
        return logger(`environment must be one of ${validEnvironments.join(", ")}`, MessageType.Error)
    }

    var url = ORDERCLOUD_URLS[environment];

    // Set up configuration
    Configuration.Set({ baseApiUrl: url });

    // Authenticate
    var portal = new PortalAPI(); 
    var org_token: string;
    if (_.isNil(portalToken)) {
        if (_.isNil(username) || _.isNil(password)) {
            return logger(`Missing required arguments: username and password`, MessageType.Error)
        }
        try {
            portalToken = (await portal.login(username, password)).access_token;
        } catch {
            return logger(`Username \"${username}\" and Password \"${password}\" were not valid`, MessageType.Error)
        }
    }
    try {
        org_token = await portal.getOrganizationToken(marketplaceID, portalToken);
    } catch (e) {
        console.log(JSON.stringify(e));
        return logger(`Marketplace with ID \"${marketplaceID}\" not found`, MessageType.Error)
    }
    var decoded = jwt_decode(org_token) as any;

    if (decoded.aud !== url) {
        return logger(`Marketplace \"${marketplaceID}\" found, but is not in environment \"${environment}\"`, MessageType.Error)
    }

    Tokens.SetAccessToken(org_token);

    logger(`Found your Marketplace \"${marketplaceID}\" . Beginning download.`, MessageType.Success);

    // Pull Data from Ordercloud
    var marketplace = new SerializedMarketplace();
    var directory = await BuildResourceDirectory(false); 
    for (let resource of directory) {
        if (resource.isChild) {
            continue; // resource will be handled as part of its parent
        }
        var records = await OrderCloudBulk.ListAll(resource);
        RedactSensitiveFields(resource, records);
        PlaceHoldMarketplaceID(resource, records);
        if (resource.downloadTransformFunc !== undefined) {
            records = records.map(resource.downloadTransformFunc)
        }
        marketplace.AddRecords(resource, records);
        for (let childResourceName of resource.children)
        {
            let childResource = directory.find(x => x.name === childResourceName);
            for (let parentRecord of records) {
                var childRecords = await OrderCloudBulk.ListAll(childResource, parentRecord.ID); // assume ID exists. Which is does for all parent types.
                for (let childRecord of childRecords) {
                    childRecord[childResource.parentRefField] = parentRecord.ID;
                }
                if (childResource.downloadTransformFunc !== undefined) {
                    childRecords = childRecords.map(resource.downloadTransformFunc)
                }
                marketplace.AddRecords(childResource, childRecords);
            }
            logger("Downloaded " + childRecords.length + " " + childResourceName);
        }
        logger("Downloaded " + records.length + " " + resource.name);
    }
    // Write to file
    logger(`Done downloading data from org \"${marketplaceID}\".`, MessageType.Success);
    return marketplace;

    function RedactSensitiveFields(resource: OCResource, records: any[]): void {
        if (resource.redactFields.length === 0) return;

        for (var record of records) {
            for (var field of resource.redactFields) {
                if (!_.isNil(record[field])) {
                    record[field] = REDACTED_MESSAGE;
                }
            }
        }
    }

    function PlaceHoldMarketplaceID(resource: OCResource, records: any[]): void {
        if (resource.hasOwnerIDField) {
            for (var record of records) {  
                if (record.OwnerID === marketplaceID) {
                    record.OwnerID = MARKETPLACE_ID;
                }
            }
        }
    }
} 

//dotenv.config({ path: '.env' });

//download(process.env.PORTAL_USERNAME, process.env.PORTAL_PASSWORD, process.env.OC_ENV, process.env.ORG_ID, 'ordercloud-seed.yml');