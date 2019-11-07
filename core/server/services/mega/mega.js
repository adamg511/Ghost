const url = require('url');
const moment = require('moment');
const common = require('../../lib/common');
const api = require('../../api');
const membersService = require('../members');
const bulkEmailService = require('../bulk-email');
const models = require('../../models');
const postEmailSerializer = require('./post-email-serializer');
const urlUtils = require('../../lib/url-utils');

const sendEmail = async (post, members) => {
    const emailTmpl = postEmailSerializer.serialize(post);

    const membersToSendTo = members.filter((member) => {
        return membersService.contentGating.checkPostAccess(post, member);
    });
    const emails = membersToSendTo.map(member => member.email);
    const emailData = membersToSendTo.reduce((emailData, member) => {
        return Object.assign({
            [member.email]: {
                unsubscribe_url: createUnsubscribeUrl(member)
            }
        }, emailData);
    }, {});

    return bulkEmailService.send(emailTmpl, emails, emailData)
        .then(() => ({emailTmpl, emails}));
};

const sendTestEmail = async (post, emails) => {
    const emailTmpl = postEmailSerializer.serialize(post);
    emailTmpl.subject = `${emailTmpl.subject} [Test]`;
    return bulkEmailService.send(emailTmpl, emails);
};

// NOTE: serialization is needed to make sure we are using current API and do post transformations
//       such as image URL transformation from relative to absolute
const serialize = async (model) => {
    const frame = {options: {context: {user: true}}};
    const apiVersion = model.get('api_version') || 'v3';
    const docName = 'posts';

    await api.shared
        .serializers
        .handle
        .output(model, {docName: docName, method: 'read'}, api[apiVersion].serializers.output, frame);

    return frame.response[docName][0];
};

/**
 * createUnsubscribeUrl
 *
 * Takes a member and returns the url that should be used to unsubscribe
 *
 * @param {object} member
 * @param {string} member.uuid
 */
function createUnsubscribeUrl(member) {
    const siteUrl = urlUtils.getSiteUrl();
    const unsubscribeUrl = new URL(siteUrl);
    unsubscribeUrl.searchParams.set('action', 'unsubscribe');
    unsubscribeUrl.searchParams.set('unsubscribe', member.uuid);

    return unsubscribeUrl.href;
}

/**
 * handleUnsubscribeRequest
 *
 * Takes a request/response pair and reads the `unsubscribe` query parameter,
 * using the content to update the members service to set the `subscribed` flag
 * to false on the member
 *
 * If any operation fails, or the request is invalid the function will error - so using
 * as middleware should consider wrapping with `try/catch`
 *
 * @param {Request} req
 * @returns {Promise<void>}
 */
async function handleUnsubscribeRequest(req) {
    if (!req.url) {
        throw new common.errors.BadRequestError({
            message: 'Expected unsubscribe param containing token'
        });
    }

    const {query} = url.parse(req.url, true);
    if (!query || !query.unsubscribe) {
        throw new common.errors.BadRequestError({
            message: 'Expected unsubscribe param containing token'
        });
    }

    const member = await membersService.api.members.get({
        uuid: query.unsubscribe
    });

    if (!member) {
        throw new common.errors.BadRequestError({
            message: 'Expected valid subscribe param - could not find member'
        });
    }

    try {
        await membersService.api.members.update({subscribed: false}, {id: member.id});
    } catch (err) {
        throw new common.errors.InternalServerError({
            message: 'Failed to unsubscribe member'
        });
    }
}

async function listener(model, options) {
    // CASE: do not send email if we import a database
    // TODO: refactor post.published events to never fire on importing
    if (options && options.importing) {
        return;
    }

    if (!model.get('send_email_when_published')) {
        return;
    }

    const post = await serialize(model);

    const deliveredEvents = await models.Action.findAll({
        filter: `event:delivered+resource_id:${model.id}`
    });

    if (deliveredEvents && deliveredEvents.toJSON().length > 0) {
        return;
    }

    const {members} = await membersService.api.members.list(Object.assign({filter: 'subscribed:true'}, {limit: 'all'}));

    if (!members.length) {
        return;
    }

    sendEmail(post, members)
        .then(async ({emailTmpl, emails}) => {
            return models.Email.add({
                post_id: post.id,
                status: 'sent',
                email_count: emails.length,
                subject: emailTmpl.subject,
                html: emailTmpl.html,
                plaintext: emailTmpl.plaintext,
                submitted_at: moment().toDate()
            }, {context: {internal: true}});
        })
        .then(async () => {
            let actor = {id: null, type: null};
            if (options.context && options.context.user) {
                actor = {
                    id: options.context.user,
                    type: 'user'
                };
            }
            const action = {
                event: 'delivered',
                resource_id: model.id,
                resource_type: 'post',
                actor_id: actor.id,
                actor_type: actor.type
            };
            return models.Action.add(action, {context: {internal: true}});
        });
}

function listen() {
    common.events.on('post.published', listener);
}

// Public API
module.exports = {
    listen,
    sendTestEmail,
    handleUnsubscribeRequest,
    createUnsubscribeUrl
};