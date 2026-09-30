import mongoose, { Types } from 'mongoose';
import { createCollectionSchema } from './mongodb.schemas';

const Project = mongoose.model(
  'ProjectVisibilitySchemaTest',
  createCollectionSchema({ name: 'projects' }),
);

describe('Project visibility schema', () => {
  afterAll(() => {
    mongoose.deleteModel('ProjectVisibilitySchemaTest');
  });

  const projectInput = {
    organizationId: new Types.ObjectId(),
    name: 'Example',
    code: 'EX',
    status: 'ACTIVE',
    createdBy: new Types.ObjectId(),
  };

  it('defaults new Projects to PRIVATE', () => {
    const project = new Project(projectInput);
    expect(project.visibility).toBe('PRIVATE');
    expect(project.validateSync()).toBeUndefined();
  });

  it('accepts PUBLIC and rejects unsupported visibility values', () => {
    const publicProject = new Project({
      ...projectInput,
      visibility: 'PUBLIC',
    });
    expect(publicProject.validateSync()).toBeUndefined();

    const invalidProject = new Project({
      ...projectInput,
      visibility: 'TEAM_ONLY',
    });
    expect(invalidProject.validateSync()?.errors.visibility).toBeDefined();
  });
});
