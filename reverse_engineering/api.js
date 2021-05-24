'use strict';

const async = require('async');
const _ = require('lodash');
const gremlinHelper = require('./gremlinHelper');
const { prepareError } = require('./utils');

module.exports = {
    connect: function (connectionInfo, logger, cb) {
        logger.clear();
        logger.log('info', connectionInfo, 'connectionInfo', connectionInfo.hiddenKeys);
        gremlinHelper.connect(connectionInfo, logger).then(cb, cb);
    },

    disconnect: function (connectionInfo, cb) {
        gremlinHelper.close();
        cb();
    },

    testConnection: function (connectionInfo, logger, cb) {
        this.connect(connectionInfo, logger, error => {
            if (error) {
                cb({ message: 'Connection error', stack: error.stack });
                return;
            }

            gremlinHelper
                .testConnection()
                .then(() => {
                    this.disconnect(connectionInfo, () => {});
                    cb();
                })
                .catch(error => {
                    this.disconnect(connectionInfo, () => {});
                    logger.log('error', prepareError(error));
                    cb({ message: 'Connection error', stack: error.stack });
                });
        });
    },

    getDatabases: function (connectionInfo, logger, cb) {
        cb();
    },

    getDocumentKinds: function (connectionInfo, logger, cb) {
        cb();
    },

    getDbCollectionsNames: function (connectionInfo, logger, cb) {
        gremlinHelper
            .connect(connectionInfo, logger)
            .then(() => {
                return gremlinHelper
                    .getLabels()
                    .then(dbCollections => {
                        cb(null, [
                            {
                                dbCollections,
                                dbName: connectionInfo.graphName,
                            },
                        ]);
                    })
                    .catch(error => {
                        logger.log('error', prepareError(error));
                        cb(error || 'error');
                    });
            })
            .catch(error => {
                logger.log('error', prepareError(error));
                cb({ message: 'Connection error', stack: error.stack });
            });
    },

    getDbCollectionsData: function (data, logger, cb) {
        logger.clear();
        logger.log('info', data, 'connectionInfo', data.hiddenKeys);

        const collections = data.collectionData.collections;
        const dataBaseNames = data.collectionData.dataBaseNames;
        const fieldInference = data.fieldInference;
        const includeEmptyCollection = data.includeEmptyCollection;
        const recordSamplingSettings = data.recordSamplingSettings;
        let packages = {
            labels: [],
            relationships: [],
        };

        async.map(
            dataBaseNames,
            (dbName, next) => {
                let labels = collections[dbName];
                let metaData = {};

                gremlinHelper
                    .getGraphSchema()
                    .then(async schema => {
                        logger.log('info', schema, 'Graph Schema');

                        metaData.features = await gremlinHelper.getFeatures();
                        metaData.variables = await gremlinHelper.getVariables();
                        metaData.propertyKeys = await gremlinHelper.getPropertyKeys();
                    })
                    .then(() => gremlinHelper.getIndexes())
                    .then(({ compositeIndexes, mixedIndexes, vertexCentricIndexes }) => {
                        logger.progress({
                            message: `Indexes have retrieved successfully`,
                            containerName: dbName,
                            entityName: '',
                        });
                        metaData.compositeIndexes = compositeIndexes;
                        metaData.mixedIndexes = mixedIndexes;
                        metaData.vertexCentricIndexes = vertexCentricIndexes;
                    })
                    .then(() => {
                        return gremlinHelper
                            .getRelationshipsLabels()
                            .then(gremlinHelper.getRelationshipSchema(logger, getCount(10000, recordSamplingSettings)))
                            .then(relationships => relationships.flatMap(relationships => relationships));
                    })
                    .then(schema => {
                        return schema.filter(data => {
                            return labels.indexOf(data.start) !== -1 && labels.indexOf(data.end) !== -1;
                        });
                    })
                    .then(schema => {
                        return getRelationshipData({
                            schema,
                            dbName,
                            recordSamplingSettings,
                            fieldInference,
                            propertyKeys: metaData.propertyKeys,
                            asModelDefinitions: data.asModelDefinitions,
                        });
                    })
                    .then(relationships => {
                        packages.relationships.push(relationships.map(relationship => relationship.packageData));

                        const relationshipDefinitions =
                            gremlinHelper.mergeJsonSchemas(
                                relationships.map(relationship => relationship.relationshipDefinitions)
                            )?.properties || {};

                        return getNodesData(dbName, labels, logger, {
                            recordSamplingSettings,
                            fieldInference,
                            includeEmptyCollection,
                            compositeIndexes: metaData.compositeIndexes,
                            mixedIndexes: metaData.mixedIndexes,
                            vertexCentricIndexes: metaData.vertexCentricIndexes,
                            features: metaData.features,
                            variables: metaData.variables,
                            propertyKeys: metaData.propertyKeys,
                            asModelDefinitions: data.asModelDefinitions,
                            relationshipDefinitions,
                        });
                    })
                    .then(labelPackages => {
                        packages.labels.push(labelPackages);
                        next(null);
                    })
                    .catch(error => {
                        logger.log('error', prepareError(error), 'Error');
                        next(prepareError(error));
                    });
            },
            err => {
                cb(err, packages.labels, {}, [].concat.apply([], packages.relationships));
            }
        );
    },
};

const getCount = (count, recordSamplingSettings) => {
    const per = recordSamplingSettings.relative.value;
    const size =
        recordSamplingSettings.active === 'absolute'
            ? recordSamplingSettings.absolute.value
            : Math.round((count / 100) * per);
    return size;
};

const isEmptyLabel = documents => {
    if (!Array.isArray(documents)) {
        return true;
    }

    return documents.reduce((result, doc) => result && _.isEmpty(doc), true);
};

const getTemplate = (documents, rootTemplateArray = []) => {
    const template = rootTemplateArray.reduce((template, key) => Object.assign({}, template, { [key]: {} }), {});

    if (!_.isArray(documents)) {
        return template;
    }

    return documents.reduce((tpl, doc) => _.merge(tpl, doc), template);
};

const getNodesData = (dbName, labels, logger, data) => {
    return new Promise((resolve, reject) => {
        let packages = [];
        async.map(
            labels,
            (labelName, nextLabel) => {
                logger.progress({ message: 'Start sampling data', containerName: dbName, entityName: labelName });
                gremlinHelper
                    .getNodesCount(labelName)
                    .then(quantity => {
                        logger.progress({
                            message: 'Start getting data from graph',
                            containerName: dbName,
                            entityName: labelName,
                        });
                        const count = getCount(quantity, data.recordSamplingSettings);

                        return gremlinHelper
                            .getNodes(labelName, count)
                            .then(documents => ({ limit: count, documents }));
                    })
                    .then(async ({ documents, limit }) => {
                        const entityLevelData = await gremlinHelper.getVertexLabelData(labelName);

                        const schemaData = await gremlinHelper.getSchema({
                            gremlinElement: 'V',
                            documents,
                            label: labelName,
                            limit,
                            propertyKeys: data.propertyKeys,
                            properties: entityLevelData.properties,
                        });

                        return {
                            documents: schemaData.documents,
                            schema: schemaData.schema,
                            template: schemaData.template,
                            entityLevel: entityLevelData.entityLevel,
                        };
                    })
                    .then(({ documents, schema, template, entityLevel }) => {
                        logger.progress({
                            message: `Data has successfully got`,
                            containerName: dbName,
                            entityName: labelName,
                        });
                        const packageData = getLabelPackage({
                            dbName,
                            labelName,
                            documents,
                            schema,
                            template,
                            entityLevel,
                            includeEmptyCollection: data.includeEmptyCollection,
                            fieldInference: data.fieldInference,
                            compositeIndexes: data.compositeIndexes,
                            mixedIndexes: data.mixedIndexes,
                            vertexCentricIndexes: data.vertexCentricIndexes,
                            features: data.features,
                            variables: data.variables,
                            propertyKeys: data.propertyKeys,
                            relationshipDefinitions: data.relationshipDefinitions,
                            asModelDefinitions: data.asModelDefinitions,
                        });
                        if (packageData) {
                            packages.push(packageData);
                        }
                        nextLabel(null);
                    })
                    .catch(nextLabel);
            },
            err => {
                if (err) {
                    reject(err);
                } else {
                    const sortedPackages = sortPackagesByLabels(packages);
                    resolve(sortedPackages);
                }
            }
        );
    });
};

const sortPackagesByLabels = packages => _.orderBy(packages, item => item.collectionName);

const getRelationshipData = ({
    schema,
    dbName,
    recordSamplingSettings,
    fieldInference,
    propertyKeys,
    asModelDefinitions,
}) => {
    return new Promise((resolve, reject) => {
        async.map(
            schema,
            (chain, nextChain) => {
                gremlinHelper
                    .getCountRelationshipsData(chain.start, chain.relationship, chain.end)
                    .then(quantity => {
                        const count = getCount(quantity, recordSamplingSettings);
                        return gremlinHelper.getRelationshipData({
                            start: chain.start,
                            relationship: chain.relationship,
                            end: chain.end,
                            limit: count,
                            propertyKeys,
                            properties: chain.properties,
                        });
                    })
                    .then(({ documents, schema, template }) => {
                        let packageData = {
                            dbName,
                            parentCollection: chain.start,
                            relationshipName: chain.relationship,
                            childCollection: chain.end,
                            level: 'entity',
                            documents,
                            validation: {
                                jsonSchema: asModelDefinitions ? convertSchemaToRefs(schema) : schema,
                            },
                            relationshipInfo: {
                                biDirectional: chain.biDirectional,
                                multiplicity: chain.multiplicity,
                                edgeTTL: chain.edgeTTL,
                            },
                        };

                        if (fieldInference.active === 'field') {
                            packageData.documentTemplate = getTemplate(documents, template);
                        }

                        nextChain(null, { packageData, relationshipDefinitions: schema });
                    })
                    .catch(nextChain);
            },
            (err, packages) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(packages);
                }
            }
        );
    });
};

const getLabelPackage = ({
    dbName,
    labelName,
    documents,
    template,
    schema,
    entityLevel,
    includeEmptyCollection,
    fieldInference,
    compositeIndexes,
    mixedIndexes,
    vertexCentricIndexes,
    features,
    variables,
    propertyKeys,
    relationshipDefinitions,
    asModelDefinitions,
}) => {
    let packageData = {
        dbName,
        collectionName: labelName,
        documents,
        views: [],
        emptyBucket: false,
        entityLevel,
        validation: {
            jsonSchema: asModelDefinitions ? convertSchemaToRefs(schema) : schema,
        },
        bucketInfo: {
            compositeIndexes,
            mixedIndexes,
            vertexCentricIndexes,
            features,
            graphVariables: variables,
            traversalSource: 'g',
        },
        ...(asModelDefinitions && {
            modelDefinitions: {
                properties: {
                    ...propertyKeys,
                    ...relationshipDefinitions,
                    ...clearMetaProperties(schema.properties),
                },
            },
        }),
    };

    if (fieldInference.active === 'field') {
        packageData.documentTemplate = getTemplate(documents, template);
    }

    if (includeEmptyCollection || !isEmptyLabel(documents)) {
        return packageData;
    } else {
        return null;
    }
};

const convertSchemaToRefs = schema => {
    return {
        ...schema,
        properties: Object.fromEntries(
            Object.entries(schema.properties || {}).map(([name, property]) => [
                name,
                {
                    $ref: `#/definitions/${name}`,
                    ...(property.metaProperties && { metaProperties: property.metaProperties }),
                },
            ])
        ),
    };
};

const clearMetaProperties = (properties = {}) =>
    Object.fromEntries(
        Object.entries(properties).map(([name, property]) => [name, _.omit(property, 'metaProperties')])
    );
