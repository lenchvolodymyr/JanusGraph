const { transformToValidGremlinName, DEFAULT_INDENT, setInManagement } = require('./common');
const { generateEdges } = require('./edgeLabelHelper');
const { generatePropertyKeys } = require('./propertyKeysHelper');
const { generateVertices } = require('./vertexLabelHelper');

let _ = null;
const setDependencies = app => (_ = app.require('lodash'));

const generateJanusGraphSchema = ({ collections, relationships, containerData, app, modelDefinitions }) => {
    setDependencies(app);

    const containerTraversalSource = _.get(containerData, [0, 'traversalSource'], 'g');
    const traversalSource = transformToValidGremlinName(containerTraversalSource);

    const parsedCollections = collections.map(JSON.parse);
    const parsedRelationships = relationships.map(JSON.parse);

    const parsedModelDefinitions = JSON.parse(modelDefinitions);

    const propertyKeysScript = generatePropertyKeys({
        collections: parsedCollections,
        relationships: parsedRelationships,
        modelDefinitions: parsedModelDefinitions,
        traversalSource,
        app,
    });

    const verticesScript = generateVertices({ traversalSource, collections: parsedCollections, app });
    const edgesScript = generateEdges({ traversalSource, relationships: parsedRelationships, app });

    return [propertyKeysScript, verticesScript, edgesScript].join('\n\n');
};

module.exports = {
    generateJanusGraphSchema,
};